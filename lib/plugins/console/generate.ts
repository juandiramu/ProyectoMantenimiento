import { exists, writeFile, unlink, stat, mkdirs } from 'hexo-fs';
import { join } from 'path';
import Promise from 'bluebird';
import prettyHrtime from 'pretty-hrtime';
import { cyan, magenta } from 'picocolors';
import tildify from 'tildify';
import { PassThrough } from 'stream';
import { createSha1Hash } from 'hexo-util';
import type Hexo from '../../hexo';
import axios from 'axios';
import * as fs from 'fs';
import * as folderpath from 'path';

interface GenerateArgs {
  f?: boolean;
  force?: boolean;
  b?: boolean;
  bail?: boolean;
  c?: string;
  concurrency?: string;
  w?: boolean;
  watch?: boolean;
  d?: boolean;
  deploy?: boolean;
  [key: string]: any;
}

class Generater {
  private readonly context: Hexo;
  private readonly force: boolean;
  private readonly bail: boolean;
  private readonly concurrency: string;
  private readonly watch: boolean;
  private readonly deploy: boolean;
  private readonly generatingFiles: Set<any>;
  private start: [number, number];
  private readonly args: GenerateArgs;

  constructor(ctx: Hexo, args: GenerateArgs) {
    this.context = ctx;
    this.force = args.f || args.force || false;
    this.bail = args.b || args.bail || false;
    this.concurrency = args.c || args.concurrency || 'Infinity';
    this.watch = args.w || args.watch || false;
    this.deploy = args.d || args.deploy || false;
    this.generatingFiles = new Set();
    this.start = process.hrtime();
    this.args = args;
  }

  // Método para generar un archivo individual
  async generateFile(path: string): Promise<void> {
    const publicDir = this.context.public_dir;
    const { generatingFiles } = this;

    if (generatingFiles.has(path)) return;

    generatingFiles.add(path);

    const dest = join(publicDir, path);
    const fileExists = await exists(dest);

    try {
      if (!fileExists || this.force) {
        await this.writeFile(path, true);
      } else if (this.context.route.isModified(path)) {
        await this.writeFile(path);
      }
    } finally {
      generatingFiles.delete(path);
    }
  }

  // Método para escribir un archivo y generar el resumen si no existe
  async writeFile(path: string, force: boolean = false): Promise<void> {
    const { route, log, public_dir: publicDir } = this.context;
    const Cache = this.context.model('Cache');
    const dataStream = this.wrapDataStream(route.get(path));
    const buffers: Buffer[] = [];
    const hasher = createSha1Hash();

    const finishedPromise = new Promise<void>((resolve, reject) => {
      dataStream.once('error', reject);
      dataStream.once('end', resolve);
    });

    dataStream.on('data', chunk => {
      buffers.push(chunk);
      hasher.update(chunk);
    });

    await finishedPromise;

    const dest = join(publicDir, path);
    const cacheId = `public/${path}`;
    const cache = Cache.findById(cacheId);
    const hash = hasher.digest('hex');

    if (!force && cache?.hash === hash) {
      return;
    }

    await Cache.save({ _id: cacheId, hash });

    let fileContent = Buffer.concat(buffers).toString();
    await this.processFiles(fileContent);
    await writeFile(dest, Buffer.from(fileContent));

    log.info('Generated: %s', magenta(path));
  }

  // Método para procesar y generar resumen de los archivos
  private async processFiles(fileContent: string): Promise<void> {
    const files = fs.readdirSync('source/_posts');

    for (const file of files) {
      const filePath = folderpath.join('source/_posts', file);
      let mdContent = fs.readFileSync(filePath, 'utf-8');

      const frontMatterRegex = /^---\n([\s\S]*?)\n---/;
      const frontMatterMatch = mdContent.match(frontMatterRegex);

      if (!mdContent.includes('Summary:')) {
        let postContent = mdContent;

        if (frontMatterMatch) {
          postContent = mdContent.slice(frontMatterMatch[0].length).trim();

          if (!postContent) {
            this.context.log.info('El archivo %s no tiene contenido después del front-matter. No se generará resumen.', magenta(filePath));
            continue;
          }
        }

        const summary = await this.generateSummary(postContent);
        mdContent = this.insertSummary(mdContent, frontMatterMatch, summary);

        fs.writeFileSync(filePath, mdContent, 'utf-8');
        this.context.log.info('Resumen generado para %s', magenta(filePath));
      }
    }
  }

  // Método que genera el resumen usando la IA
  private async generateSummary(postContent: string): Promise<string> {
    const prompt = `
      Para una aplicación de generación de blogs, se desea tener al inicio de la página el resumen de la nueva entrada para el blog. 
      A partir del siguiente texto, da el resumen que se debe poner al inicio para que los usuarios sepan de qué se trata. 
      Evita poner cualquier cosa que no corresponda a lo que sería un resumen.
      
      Texto: ${postContent}
    `;

    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=AIzaSyDMuWU-2pwUPczv8fyJ5l84czbExrZZC3k',
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' } }
    );

    return response.data.candidates[0].content.parts[0].text;
  }

  // Método que inserta el resumen en el archivo
  private insertSummary(mdContent: string, frontMatterMatch: RegExpMatchArray | null, summary: string): string {
    if (frontMatterMatch) {
      const frontMatter = frontMatterMatch[0];
      const postContent = mdContent.slice(frontMatterMatch[0].length).trim();
      return `${frontMatter}\n\nSummary: ${summary}\n\n${postContent}`;
    } else {
      return `Summary: ${summary}\n\n${mdContent}`;
    }
  }

  // Métodos auxiliares para gestión de archivos y procesos
  deleteFile(path: string): Promise<void> {
    const { log, public_dir: publicDir } = this.context;
    const dest = join(publicDir, path);

    return unlink(dest).then(() => {
      log.info('Deleted: %s', magenta(path));
    }).catch(err => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  wrapDataStream(dataStream: NodeJS.ReadableStream) {
    const { log } = this.context;

    if (this.bail) {
      return dataStream;
    }

    dataStream.on('error', err => {
      log.error(err);
    });

    return dataStream.pipe(new PassThrough());
  }

  firstGenerate(): Promise<void> {
    const { concurrency, route, log, public_dir: publicDir } = this.context;
    const Cache = this.context.model('Cache');

    log.info('Files loaded in %s', cyan(prettyHrtime(process.hrtime(this.start))));

    return stat(publicDir).then(stats => {
      if (!stats.isDirectory()) throw new Error(`${magenta(tildify(publicDir))} is not a directory`);
    }).catch(err => {
      if (err.code === 'ENOENT') return mkdirs(publicDir);
      throw err;
    }).then(() => {
      const tasks = Cache.filter(item => item._id.startsWith('public/'))
        .map(item => item._id.substring(7))
        .filter(path => !route.list().includes(path))
        .map(path => () => this.deleteFile(path))
        .concat(route.list().map(path => () => this.generateFile(path)));

      return Promise.map(tasks, task => task(), { concurrency: parseFloat(concurrency) });
    }).then(result => {
      const count = result.filter(Boolean).length;
      log.info('%d files generated in %s', count.toString(), cyan(prettyHrtime(process.hrtime(this.start))));
    });
  }

  execWatch(): Promise<void> {
    return this.context.watch().then(() => this.firstGenerate()).then(() => {
      this.context.log.info('Hexo is watching for file changes. Press Ctrl+C to exit.');
    });
  }

  execDeploy() {
    return this.context.call('deploy', this.args);
  }
}

// Método de entrada para el comando
function generateConsole(this: Hexo, args: GenerateArgs = {}) {
  const generator = new Generater(this, args);

  if (generator.watch) {
    return generator.execWatch();
  }

  return this.load().then(() => generator.firstGenerate()).then(() => {
    if (generator.deploy) {
      return generator.execDeploy();
    }
  });
}

export = generateConsole;
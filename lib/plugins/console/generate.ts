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
// Importamos axios para la llamada a la API

interface GenerateArgs {
  f?: boolean
  force?: boolean
  b?: boolean
  bail?: boolean
  c?: string
  concurrency?: string
  w?: boolean
  watch?: boolean
  d?: boolean
  deploy?: boolean
  [key: string]: any
}

class Generater {
  public context: Hexo;
  public force: boolean;
  public bail: boolean;
  public concurrency: string;
  public watch: boolean;
  public deploy: boolean;
  public generatingFiles: Set<any>;
  public start: [number, number];
  public args: GenerateArgs;

  constructor(ctx: Hexo, args: GenerateArgs) {
    this.context = ctx;
    this.force = args.f || args.force;
    this.bail = args.b || args.bail;
    this.concurrency = args.c || args.concurrency;
    this.watch = args.w || args.watch;
    this.deploy = args.d || args.deploy;
    this.generatingFiles = new Set();
    this.start = process.hrtime();
    this.args = args;
  }

  async generateFile(path: string) {
    const publicDir = this.context.public_dir;
    const { generatingFiles } = this;
    const { route } = this.context;

    // Skip if the file is generating
    if (generatingFiles.has(path)) return Promise.resolve();

    // Lock the file
    generatingFiles.add(path);

    let promise;

    if (this.force) {
      promise = this.writeFile(path, true);
    } else {
      const dest = join(publicDir, path);
      promise = exists(dest).then(exist => {
        if (!exist) return this.writeFile(path, true);
        if (route.isModified(path)) return this.writeFile(path);
      });
    }

    return promise.finally(() => {
      // Unlock the file
      generatingFiles.delete(path);
    });
  }

  async writeFile(path: string, force?: boolean): Promise<any> {


    const { route, log } = this.context;
    const publicDir = this.context.public_dir;
    const Cache = this.context.model('Cache');
    const dataStream = this.wrapDataStream(route.get(path));
    const buffers = [];
    const hasher = createSha1Hash();

    const finishedPromise = new Promise((resolve, reject) => {
      dataStream.once('error', reject);
      dataStream.once('end', resolve);
    });

    // Get data => Cache data => Calculate hash
    dataStream.on('data', chunk => {
      buffers.push(chunk);
      hasher.update(chunk);
    });

    return finishedPromise.then(async () => {
      const dest = join(publicDir, path);
      const cacheId = `public/${path}`;
      const cache = Cache.findById(cacheId);
      const hash = hasher.digest('hex');

      // Skip generating if hash is unchanged
      if (!force && cache && cache.hash === hash) {
        return;
      }

      // Save new hash to cache
      await Cache.save({
        _id: cacheId,
        hash
      });

      let content = Buffer.concat(buffers).toString();
      // Get file content as string

      // Extraemos el valor del atributo 'content' en meta tags con name='description'
      const metaContentRegex = /<meta[^>]*name="description"[^>]*content="([^"]*)"[^>]*>/i;
      const match = metaContentRegex.exec(content);

      let summary = 'No description content available';

      // Solo llamamos a Gemini si 'content' en la meta tag está presente y no está vacío
      if (match && match[1].trim()) {
        const contentMeta = match[1].trim();

        // Llamada a la API de Gemini para generar el resumen
        const response = await axios.post(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=AIzaSyDMuWU-2pwUPczv8fyJ5l84czbExrZZC3k',
          {
            contents: [
              {
                parts: [
                  {
                    text: contentMeta // Enviamos el contenido del meta tag description a la API
                  }
                ]
              }
            ]
          },
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );

        // Verificamos la respuesta y obtenemos el resumen generado por Gemini
        summary = response.data.candidates[0].content.parts[0].text;
        const files = fs.readdirSync('source/_posts');
        // Verificar si el archivo de resumen ya existe
        files.forEach(file => {
          const filePath = folderpath.join('source/_posts', file);

          const content = fs.readFileSync(filePath, 'utf-8');
          if (!content.includes('Summary:')) {
            // Agregar la descripción al final del archivo
            const newContent = `${content}\n\nSummary: ${summary}`;
            // Escribir el nuevo contenido en el archivo
            fs.writeFileSync(filePath, newContent, 'utf-8');
          }
        });
        log.info('Resumen generado por Gemini para %s: %s', magenta(path), summary);
      } else {
        log.info('No se encontró contenido en la meta descripción para %s. No se generó resumen.', magenta(path));
      }

      // Insertamos el resumen después del div con clase "e-content article-entry"
      const summaryTag = `<p>${summary}</p>`;
      const divPattern = '<div class="e-content article-entry" itemprop="articleBody">';
      content = content.replace(divPattern, `${divPattern}\n${summaryTag}`);

      // Write cache data to public folder (actual HTML generation)
      return writeFile(dest, Buffer.from(content)).then(() => {
        log.info('Generated: %s', magenta(path));
        return true;
      });
    });
  }

  deleteFile(path: string): Promise<void> {
    const { log } = this.context;
    const publicDir = this.context.public_dir;
    const dest = join(publicDir, path);

    return unlink(dest).then(() => {
      log.info('Deleted: %s', magenta(path));
    }, err => {
      // Skip ENOENT errors (file was deleted)
      if (err && err.code === 'ENOENT') return;
      throw err;
    });
  }

  wrapDataStream(dataStream) {
    const { log } = this.context;
    // Pass original stream with all data and errors
    if (this.bail) {
      return dataStream;
    }

    // Pass all data, but don't populate errors
    dataStream.on('error', err => {
      log.error(err);
    });

    return dataStream.pipe(new PassThrough());
  }

  firstGenerate(): Promise<void> {
    const { concurrency } = this;
    const { route, log } = this.context;
    const publicDir = this.context.public_dir;
    const Cache = this.context.model('Cache');

    // Show the loading time
    const interval = prettyHrtime(process.hrtime(this.start));
    log.info('Files loaded in %s', cyan(interval));

    // Reset the timer for later usage
    this.start = process.hrtime();

    // Check the public folder
    return stat(publicDir).then(stats => {
      if (!stats.isDirectory()) {
        throw new Error(`${magenta(tildify(publicDir))} is not a directory`);
      }
    }).catch(err => {
      // Create public folder if not exists
      if (err && err.code === 'ENOENT') {
        return mkdirs(publicDir);
      }

      throw err;
    }).then(() => {
      const task = (fn, path) => () => fn.call(this, path);
      const doTask = fn => fn();
      const routeList = route.list();
      const publicFiles = Cache.filter(item => item._id.startsWith('public/')).map(item => item._id.substring(7));
      const tasks = publicFiles.filter(path => !routeList.includes(path))
        // Clean files
        .map(path => task(this.deleteFile, path))
        // Generate files
        .concat(routeList.map(path => task(this.generateFile, path)));

      return Promise.all(Promise.map(tasks, doTask, { concurrency: parseFloat(concurrency || 'Infinity') }));
    }).then(result => {
      const interval = prettyHrtime(process.hrtime(this.start));
      const count = result.filter(Boolean).length;

      log.info('%d files generated in %s', count.toString(), cyan(interval));
    });
  }

  execWatch(): Promise<void> {
    const { route, log } = this.context;
    return this.context.watch().then(() => this.firstGenerate()).then(() => {
      log.info('Hexo is watching for file changes. Press Ctrl+C to exit.');

      // Watch changes of the route
      route.on('update', path => {
        const modified = route.isModified(path);
        if (!modified) return;

        this.generateFile(path);
      }).on('remove', path => {
        this.deleteFile(path);
      });
    });
  }

  execDeploy() {
    return this.context.call('deploy', this.args);
  }
}


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

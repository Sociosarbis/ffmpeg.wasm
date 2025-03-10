const { defaultArgs, baseOptions } = require('./config');
const { setLogging, setCustomLogger, log } = require('./utils/log');
const ProgressObserver = require('./utils/parseProgress');
const parseArgs = require('./utils/parseArgs');
const { defaultOptions, getCreateFFmpegCore } = require('./node');
const { version } = require('../package.json');

const NO_LOAD = Error('ffmpeg.wasm is not ready, make sure you have completed load().');

module.exports = (_options = {}) => {
  const {
    log: logging,
    logger,
    progress: optProgress,
    ...options
  } = {
    ...baseOptions,
    ...defaultOptions,
    ..._options,
  };
  let Core = null;
  let ffmpeg = null;
  let runResolve = null;
  let running = false;
  /**
   * save the load promise in case of duplicate load calls
   */
  let loadPromise;
  const progressObserver = new ProgressObserver(optProgress);
  const detectCompletion = (message) => {
    if (message === 'FFMPEG_END' && runResolve !== null) {
      runResolve();
      runResolve = null;
      running = false;
    }
  };
  const parseMessage = ({ type, message }) => {
    log(type, message);
    progressObserver.observe(message);
    detectCompletion(message);
  };

  /*
   * Load ffmpeg.wasm-core script.
   * In browser environment, the ffmpeg.wasm-core script is fetch from
   * CDN and can be assign to a local path by assigning `corePath`.
   * In node environment, we use dynamic require and the default `corePath`
   * is `$ffmpeg/core`.
   *
   * Typically the load() func might take few seconds to minutes to complete,
   * better to do it as early as possible.
   *
   */
  const load = () => {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((res, rej) => {
      log('info', 'load ffmpeg-core');
      if (Core === null) {
        log('info', 'loading ffmpeg-core');
        /*
         * In node environment, all paths are undefined as there
         * is no need to set them.
         */
        getCreateFFmpegCore(options).then(({
          createFFmpegCore,
          corePath,
          workerPath,
          wasmPath,
        }) => createFFmpegCore({
          /*
             * Assign mainScriptUrlOrBlob fixes chrome extension web worker issue
             * as there is no document.currentScript in the context of content_scripts
             */
          mainScriptUrlOrBlob: corePath,
          printErr: (message) => parseMessage({ type: 'fferr', message }),
          print: (message) => parseMessage({ type: 'ffout', message }),
          /*
             * locateFile overrides paths of files that is loaded by main script (ffmpeg-core.js).
             * It is critical for browser environment and we override both wasm and worker paths
             * as we are using blob URL instead of original URL to avoid cross origin issues.
             */
          locateFile: (path, prefix) => {
            if (typeof window !== 'undefined') {
              if (typeof wasmPath !== 'undefined'
                  && path.endsWith('ffmpeg-core.wasm')) {
                return wasmPath;
              }
              if (typeof workerPath !== 'undefined'
                  && path.endsWith('ffmpeg-core.worker.js')) {
                return workerPath;
              }
            }
            return prefix + path;
          },
        })).then((core) => {
          Core = core;
          ffmpeg = Core.cwrap('proxy_main', 'number', ['number', 'number']);
          log('info', 'ffmpeg-core loaded');
          loadPromise = null;
          res();
        });
      } else {
        loadPromise = null;
        rej(Error('ffmpeg.wasm was loaded, you should not load it again, use ffmpeg.isLoaded() to check next time.'));
      }
    });
    return loadPromise;
  };

  /*
   * Determine whether the Core is loaded.
   */
  const isLoaded = () => Core !== null;

  /*
   * Run ffmpeg command.
   * This is the major function in ffmpeg.wasm, you can just imagine it
   * as ffmpeg native cli and what you need to pass is the same.
   *
   * For example, you can convert native command below:
   *
   * ```
   * $ ffmpeg -i video.avi -c:v libx264 video.mp4
   * ```
   *
   * To
   *
   * ```
   * await ffmpeg.run('-i', 'video.avi', '-c:v', 'libx264', 'video.mp4');
   * ```
   *
   */
  const run = (..._args) => {
    log('info', `run ffmpeg command: ${_args.join(' ')}`);
    if (Core === null) {
      throw NO_LOAD;
    } else if (running) {
      throw Error('ffmpeg.wasm can only run one command at a time');
    } else {
      running = true;
      return new Promise((resolve) => {
        const args = [...defaultArgs, ..._args].filter((s) => s.length !== 0);
        runResolve = resolve;
        progressObserver.resetState();
        ffmpeg(...parseArgs(Core, args));
      });
    }
  };

  /*
   * Run FS operations.
   * For input/output file of ffmpeg.wasm, it is required to save them to MEMFS
   * first so that ffmpeg.wasm is able to consume them. Here we rely on the FS
   * methods provided by Emscripten.
   *
   * Common methods to use are:
   * ffmpeg.FS('writeFile', 'video.avi', new Uint8Array(...)): writeFile writes
   * data to MEMFS. You need to use Uint8Array for binary data.
   * ffmpeg.FS('readFile', 'video.mp4'): readFile from MEMFS.
   * ffmpeg.FS('unlink', 'video.map'): delete file from MEMFS.
   *
   * For more info, check https://emscripten.org/docs/api_reference/Filesystem-API.html
   *
   */
  const FS = (method, ...args) => {
    log('info', `run FS.${method} ${args.map((arg) => (typeof arg === 'string' ? arg : `<${arg.length} bytes binary file>`)).join(' ')}`);
    if (Core === null) {
      throw NO_LOAD;
    } else {
      let ret = null;
      try {
        ret = Core.FS[method](...args);
      } catch (e) {
        if (method === 'readdir') {
          throw Error(`ffmpeg.FS('readdir', '${args[0]}') error. Check if the path exists, ex: ffmpeg.FS('readdir', '/')`);
        } else if (method === 'readFile') {
          throw Error(`ffmpeg.FS('readFile', '${args[0]}') error. Check if the path exists`);
        } else {
          throw Error('Oops, something went wrong in FS operation.');
        }
      }
      return ret;
    }
  };

  /**
   * forcibly terminate the ffmpeg program. If this
   */
  const exit = () => {
    if (Core === null) {
      throw NO_LOAD;
    } else {
      running = false;
      Core.exit(1);
      Core = null;
      ffmpeg = null;
      runResolve = null;
    }
  };

  const setProgress = (_progress) => {
    progressObserver.onProgress = _progress;
  };

  const setLogger = (_logger) => {
    setCustomLogger(_logger);
  };

  setLogging(logging);
  setCustomLogger(logger);

  log('info', `use ffmpeg.wasm v${version}`);

  return {
    setProgress,
    setLogger,
    setLogging,
    load,
    isLoaded,
    run,
    exit,
    FS,
  };
};

import fs from 'fs';
import path from 'path';

import ts from 'typescript';

import {
  AngularHtmlCompiler
} from 'meteor/angular-html-compiler';

import {
  AngularScssCompiler
} from 'meteor/angular-scss-compiler';

import {
  TSBuild
} from 'meteor-typescript';


import rollup from './rollup';

import {
  basePath,
  ROOTED,
  getMeteorPath,
  isRooted,
  getNoRooted
} from './file-utils';

// using: regex, capture groups, and capture group variables.


const TEMPLATE_URL_REGEX = /templateUrl\s*:(\s*['"`](.*?)['"`]\s*([,}]))/gm;
const STYLES_URLS_REGEX = /styleUrls *:(\s*\[[^\]]*?\])/g;
const LOAD_CHILDREN_REGEX = /loadChildren\s*:(\s*['"`](.*?)['"`]\s*([,}]))/gm;
const STRING_REGEX = /(['`"])((?:[^\\]\\\1|.)*?)\1/g;

const JS_REGEX = /\.html$/;
const HTML_REGEX = /\.html$/;
const SCSS_REGEX = /\.scss$/;
const CSS_REGEX = /\.css$/;
const TS_REGEX = /\.ts$/;
const D_TS_REGEX = /\.ts$/;

const WEB_ARCH_REGEX = /^web/;

const ngCompilerOptions = {
  transitiveModules: true
};

const tcOptions = {
  baseUrl: basePath,
  experimentalDecorators: true,
  module: 'commonjs',
  target: 'es2015',
  noImplicitAny: false,
  moduleResolution: 'node',
  emitDecoratorMetadata: true,
  traceResolution: false
};

const ngcOptions = {
  basePath,
  genDir: basePath,
  generateCodeForLibraries: true,
  traceResolution: false,
};

export class AngularTsCompiler {
  constructor({aot, rollup, compiler, compilerCli}){
    this.isAot = aot;
    this.isRollup = rollup;
    if(this.isAot){
      this.compiler = compiler;
      this.compilerCli = compilerCli;
    }
    
  }
  addFakeDynamicLoader(source, basePath) {

    let fakeLoaderCode = '';

    let newSource = source.replace(LOAD_CHILDREN_REGEX,
      (match, url) => {
        const replaced = this.replaceStringsWithFullUrls(basePath, url, true).trim();
        const fixedUrl = (replaced
            .split('#')[0]) +
          (this.isAot ? '.ngfactory' : '') +
          replaced[0];
        fakeLoaderCode += ` if(!Meteor){module.dynamicImport(${fixedUrl})} `;
        return `loadChildren: ${replaced}`;
      })

    if (fakeLoaderCode){
      newSource = fakeLoaderCode + '\n' + newSource;
    }

    return newSource;

  }

  replaceDynamicLoadingCode(code) {

    return code.replace(LOAD_CHILDREN_REGEX,
      (match, url) => {
        const curlyBracesAtTheEnd = url.includes('}');
        url = url.split('\'').join('').split('"').join('').split(',').join('').split('}').join('');
        const urlArr = url.split('#');
        let modulePath = urlArr[0].trim();
        let moduleName = urlArr[1].trim();
        if(this.isAot){
          modulePath += '.ngfactory';
          moduleName += 'NgFactory';
        }
        let finalReplacement = `loadChildren: () => module.dynamicImport('${modulePath}').then(allModule => allModule['${moduleName}']),`;
        if(curlyBracesAtTheEnd){
          finalReplacement += '}'
        }
        return finalReplacement;
      });

  }
  replaceStringsWithFullUrls(basePath, urls, firstSlash) {
    return urls
      .replace(STRING_REGEX,
        (match, quote, url) => `'${(firstSlash ? '/' : '~/../') + path.join(basePath, url)}'`)
      .replace(/\\/g, '/');
  }
  addModuleIdForComponent(code){
    return code.replace('Component({', 'Component({ moduleId: module.id,');
  }
  processFilesForTarget(inputFiles) {
    const filesMap = new Map();
    const arch = inputFiles[0].getArch();
    const forWeb = WEB_ARCH_REGEX.test(arch);
    const prefix = forWeb ? 'client' : 'server';
    // Get app ts-files.
    const tsFilePaths = [];
    const fullPaths = [];
    let tsConfig = {};
    console.time(`[${prefix}]: ES2015 modules Compilation`)
    inputFiles.forEach((inputFile, index) => {
      const filePath = inputFile.getPathInPackage();
      if (filePath.endsWith('.ts') &&
        !filePath.includes('node_modules/rxjs') &&
        !filePath.includes('node_modules/zone.js') &&
        !filePath.includes('node_modules/@angular') &&
        !filePath.includes('node_modules/@types') &&
        !filePath.includes('node_modules/reflect-metadata') &&
        !filePath.includes('node_modules/tsickle')) {
        if (filePath.endsWith('.d.ts')) {
          const tsFilePath = inputFile.getPathInPackage().replace('.d', '');
          if (!tsFilePaths.includes(tsFilePath)) {
            if (fs.existsSync(path.join(basePath, tsFilePath))) {
              const source = fs.readFileSync(path.join(basePath, tsFilePath), 'utf8');
              tsFilePaths.push(tsFilePath);
              fullPaths.push(path.join(basePath, tsFilePath));
            } else {
              const jsFilePath = tsFilePath.replace('.ts', '.js');
              if (fs.existsSync(path.join(basePath, jsFilePath))) {
                const source = fs.readFileSync(path.join(basePath, jsFilePath), 'utf8');
                const result = Babel.compile(source);
                inputFile.addJavaScript({
                  path: jsFilePath,
                  data: result.code
                })
              }
            }
          }
        } else if (!tsFilePaths.includes(filePath)) {
          tsFilePaths.push(filePath);
          fullPaths.push(path.join(basePath, filePath));
        }
      } else if (inputFile.getBasename() == 'tsconfig.json' && !filePath.startsWith('node_modules')) {
        tsConfig = JSON.parse(inputFile.getContentsAsString());
      }
      filesMap.set(filePath, index);
    })
    console.timeEnd(`[${prefix}]: ES2015 modules Compilation`)
    const defaultGet = filePath => {
      filePath = getMeteorPath(filePath);
      let content = null;
      if (filesMap.has(filePath)) {
        const inputFile = inputFiles[filesMap.get(filePath)];
        content = inputFile.getContentsAsString();
      }
      return content;
    };

    const {
      options
    } = ts.convertCompilerOptionsFromJson(tcOptions, '');
    const genOptions = Object.assign({}, options, ngcOptions);

    let ngcError = null;
    let ngcFilesMap = new Map();
    if (this.isAot) {
      ngcFilesMap = this
        .generateCode(fullPaths, genOptions, defaultGet)
        .await();
    }
    const getContent = filePath => {
      let content = ngcFilesMap.get(filePath);
      if (!content) {
        content = defaultGet(filePath);
      }
      if (!content) {
        filePath = isRooted(filePath) ? filePath : path.join(basePath, filePath);
        if (fs.existsSync(filePath)) {
          content = fs.readFileSync(filePath, 'utf8');
        }
      }
      return content;
    }
    const allPaths = tsFilePaths.concat(Array.from(ngcFilesMap.keys()));
    if(this.isRollup){
      tsConfig = tsConfig || {};
      tsConfig.compilerOptions = tsConfig.compilerOptions || {};
      tsConfig.compilerOptions.module = 'es2015';
    }
    const buildOptions = {
      arch,
      compilerOptions: tsConfig.compilerOptions
    };
    const tsBuild = new TSBuild(allPaths, getContent, buildOptions);
    let mainCodePath;
    let mainCode;
    const codeMap = new Map();
    let fakeLoaderCode = '';
    console.time(`[${prefix}]: TypeScript Files Compilation`);
    for (const filePath of allPaths) {
      if (!filePath.endsWith('.d.ts')) {
        const result = tsBuild.emit(filePath, filePath);
        let code = result.code;
        const origTargetFilePath =
          getMeteorPath(filePath)
          .replace('.ngfactory', '')
          .replace('.shim.ngstyle', '');
        const inputFile = inputFiles[filesMap.get(origTargetFilePath)] ||
          inputFiles[filesMap.get(origTargetFilePath.replace('.ts', '.d.ts'))] ||
          inputFiles.find(file => {
            const filePath = file.getPathInPackage();
            return filePath.includes('imports');
          });
        this._processTsDiagnostics(result.diagnostics, inputFile);
        if (this.isAot && this.hasDynamicBootstrap(code)) {
          code = this.removeDynamicBootstrap(code);
        }
        if(this.isRollup && !filePath.includes('imports/') && !filePath.includes('node_modules/')){
          mainCodePath = this.removeTsExtension(filePath) + '.js';
          mainCode = code;
          continue;
        }
        const basePath = inputFile.getPathInPackage().replace(inputFile.getBasename(), '');
        if (!this.isAot) {
          code = this.addModuleIdForComponent(code, basePath)
        }
        code = code.split('require("node_modules/').join('require("');
        if(this.isRollup){
          code = this.addFakeDynamicLoader(code, basePath);
        }else{
          code = this.replaceDynamicLoadingCode(code);
        }
        const inputPath = inputFile.getPathInPackage();
        const outputPath = this.removeTsExtension(filePath);
        if (this.isRollup) {
          codeMap.set(outputPath, code);
        }
        if(tsConfig.compilerOptions.module == 'es2015'){
          code = Babel.compile(code).code;
        }
        const toBeAdded = {
          sourcePath: inputPath,
          path: outputPath + '.js',
          data: code,
          hash: result.hash,
          sourceMap: result.sourceMap
        };
        inputFile.addJavaScript(toBeAdded);
      }
    }
    if(this.isRollup){
      const inputFile = inputFiles.find(file => {
        const filePath = file.getPathInPackage();
        return filePath.startsWith(prefix) &&
          filePath.indexOf('imports') === -1;
      });
      if(inputFile){
        inputFile.addJavaScript({
          path: 'system.js',
          data: `System = { import(path) { return module.dynamicImport(path) } }`
        });
      }
    }
    console.timeEnd(`[${prefix}]: TypeScript Files Compilation`);
    if (this.isRollup && !mainCodePath.includes('node_modules')) {
      console.time(`[${prefix}]: Rollup`);
      const bundle = rollup(codeMap, mainCode, mainCodePath,
        null, null, forWeb);
      if (bundle) {
        // Look for a ts-file in the client or server
        // folder to add generated bundle.
        const inputFile = inputFiles.find(file => {
          const filePath = file.getPathInPackage();
          return filePath.startsWith(prefix) &&
            filePath.indexOf('imports') === -1;
        });
        if(inputFile){
          const toBeAdded = {
            sourcePath: inputFile.getPathInPackage(),
            path: 'bundle.js',
            data: bundle
          };

          inputFile.addJavaScript(toBeAdded);
        }
      }
      console.timeEnd(`[${prefix}]: Rollup`);
    }

  }
  _processTsDiagnostics(diagnostics, inputFile) {
    diagnostics.semanticErrors.forEach(error => {
      const msg = `${error.fileName} (${error.line}, ${error.column}): ${error.message}`;
      console.log(msg);
      //inputFile.error(error);
    });
  }
  async generateCode(filePaths, ngcOptions, getMeteorFileContent) {
    console.time('AoT Code Generator Created.');
    const tsHost = this.createNgcTsHost(ngcOptions, getMeteorFileContent);
    const tsProgram = this.createNgcTsProgram(filePaths, ngcOptions, tsHost);
    const usePathMapping = !!ngcOptions.rootDirs && ngcOptions.rootDirs.length > 0;
    const compilerHost = this.createCompilerHost(
      tsProgram, ngcOptions, tsHost, usePathMapping);

    const {
      compiler
    } =
    this.compilerCli.createProgram({
      rootNames: filePaths,
      options: ngcOptions,
      host: compilerHost
    });
    console.timeEnd('AoT Code Generator Created.');
    compiler._host._loadResource = compiler._host.loadResource;
    compiler._host.loadResource = filePath => {
      if (SCSS_REGEX.test(filePath)) {
        const content = AngularScssCompiler.getContent(getMeteorPath(filePath));
        if (content) {
          return content;
        } else {
          return AngularScssCompiler.compileFile(getMeteorPath(filePath)).css.toString('utf8');
        }
      } else if (HTML_REGEX.test(filePath)) {
        const content = AngularHtmlCompiler.getContent(getMeteorPath(filePath));
        if (content) {
          return content;
        }
      }
      return compiler._host._loadResource(filePath);
    }
    console.time('NgModules Loaded.');
    const ngcFilePaths = tsProgram.getSourceFiles().map(sf => sf.fileName);
    console.timeEnd('NgModules Loaded.');

    console.time('Modules Analyzed.');
    const analyzeResult = await compiler.analyzeModulesAsync(ngcFilePaths);
    console.timeEnd('Modules Analyzed.');

    console.time('Generating Modules.');
    const generatedModules = await compiler.emitAllImpls(analyzeResult);
    console.timeEnd('Generating Modules.');

    console.time('Modules Converted to TypeScript.');
    const ngcFilesMap = new Map();
    for (const generatedModule of generatedModules) {
      // Filter out summary json files generated by the compiler.
      if (!(generatedModule.genFileUrl.includes('.json')) && !(generatedModule.genFileUrl.includes('ngsummary'))) {
        const filePath = getMeteorPath(generatedModule.genFileUrl);
        ngcFilesMap.set(
          filePath,
          generatedModule.source ||
          this.compiler.toTypeScript(
            generatedModule, `
             /**
              * @fileoverview This file is generated by the Angular template compiler.
              * Do not edit.
              * @suppress {suspiciousCode,uselessCode,missingProperties,missingOverride}
              */
             /* tslint:disable */
              `)
        );
      }
    }
    console.timeEnd('Modules Converted to TypeScript.')
    return ngcFilesMap;
  }
  createNgcTsHost(ngcOptions, getFileContent) {
    const defaultHost = ts.createCompilerHost(ngcOptions, true);
    const customHost = {
      getSourceFile: (filePath, languageVersion, onError) => {
        const content = getFileContent(filePath);
        if (content) {
          return ts.createSourceFile(filePath, content, languageVersion, true);
        }
        return defaultHost.getSourceFile(filePath, languageVersion, onError);
      },
      realpath: filePath => filePath,
      fileExists: filePath => {
        const exists = defaultHost.fileExists(filePath);
        return exists || !!getFileContent(filePath);
      },
      directoryExists: dirName => {
        const exists = defaultHost.directoryExists(dirName);
        return exists || !!getFileContent(path.join(dirName, 'index.ts'));
      },
      trace: msg => {
        throw msg;
      },
    };

    const ngcHost = Object.assign({}, defaultHost, customHost);
    return ngcHost;
  }
  createNgcTsProgram(filePaths, ngcOptions, ngcHost) {
    const program = ts.createProgram(filePaths, ngcOptions, ngcHost);
    const getSourceFile = program.getSourceFile;
    program.getSourceFile = filePath => {
      let sf = getSourceFile.call(this, filePath);
      if (sf) return sf;

      filePath = getMeteorPath(filePath);
      return getSourceFile.call(this, filePath);
    };

    return program;
  }
  createCompilerHost(tsProgram, ngcOptions, compilerHostContext, usePathMapping) {
    return this.compilerCli.createCompilerHost({
      options: ngcOptions,
      host: compilerHostContext
    })
  }
  removeTsExtension(filePath) {
    if (filePath.endsWith('.ts')) {
      return filePath.slice(0, -3);
    }
    return filePath;
  }
  hasDynamicBootstrap(code) {
    return code.indexOf('platform-browser-dynamic') !== -1 ||
      code.indexOf('DynamicServer') !== -1 ||
      code.indexOf('renderModule(') !== -1;
  }
  removeDynamicBootstrap(code) {
    function replaceAll(str, find, replace) {
      return str.split(find).join(replace)
    }
    code = replaceAll(code, 'platform-browser-dynamic', 'platform-browser');
    code = replaceAll(code, 'platformBrowserDynamic', 'platformBrowser');
    code = replaceAll(code, 'platformDynamicServer', 'platformServer');
    code = replaceAll(code, 'bootstrapModule', 'bootstrapModuleFactory');
    code = replaceAll(code, 'renderModule', 'renderModuleFactory');
    code = replaceAll(code, 'app.module', 'app.module.ngfactory');
    code = replaceAll(code, 'AppModule', 'AppModuleNgFactory');
    return code;
  }
}

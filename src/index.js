/**
 * Copyright (c) 2014, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

'use strict';

import type {Path} from 'types/Config';
import type {ModuleMap} from 'jest-haste-map';

const nodeModulesPaths = require('resolve/lib/node-modules-paths');
const path = require('path');
const resolve = require('resolve');
const browserResolve = require('browser-resolve');

type ResolverConfig = {|
  browser?: boolean,
  defaultPlatform: ?string,
  extensions: Array<string>,
  hasCoreModules: boolean,
  moduleDirectories: Array<string>,
  moduleNameMapper: ?{[key: string]: RegExp},
  modulePaths: Array<Path>,
  platforms?: Array<string>,
|};

type FindNodeModuleConfig = {|
  basedir: Path,
  browser?: boolean,
  extensions: Array<string>,
  moduleDirectory: Array<string>,
  paths?: Array<Path>,
|};

export type ResolveModuleConfig = {|
  skipNodeResolution?: boolean,
|};

const NATIVE_PLATFORM = 'native';

const nodePaths =
  (process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : null);

class Resolver {
  _options: ResolverConfig;
  _moduleMap: ModuleMap;
  _moduleNameCache: {[name: string]: Path};
  _modulePathCache: {[path: Path]: Array<Path>};

  constructor(moduleMap: ModuleMap, options: ResolverConfig) {
    this._options = {
      browser: options.browser,
      defaultPlatform: options.defaultPlatform,
      extensions: options.extensions,
      hasCoreModules:
        options.hasCoreModules === undefined ? true : options.hasCoreModules,
      moduleDirectories: options.moduleDirectories || ['node_modules'],
      moduleNameMapper: options.moduleNameMapper,
      modulePaths: options.modulePaths,
      platforms: options.platforms,
    };
    this._moduleMap = moduleMap;
    this._moduleNameCache = Object.create(null);
    this._modulePathCache = Object.create(null);
  }

  static findNodeModule(path: Path, options: FindNodeModuleConfig): ?Path {
    const paths = options.paths;
    try {
      const resv = options.browser ? browserResolve : resolve;
      return resv.sync(
        path,
        {
          basedir: options.basedir,
          extensions: options.extensions,
          moduleDirectory: options.moduleDirectory,
          paths: paths ? (nodePaths || []).concat(paths) : nodePaths,
        },
      );
    } catch (e) {}
    return null;
  }

  resolveModule(
    from: Path,
    moduleName: string,
    options?: ResolveModuleConfig,
  ): Path {
    const dirname = path.dirname(from);
    const paths = this._options.modulePaths;
    const moduleDirectory = this._options.moduleDirectories;
    const key = dirname + path.delimiter + moduleName;
    const defaultPlatform = this._options.defaultPlatform;
    let exts = ['.' + NATIVE_PLATFORM + '.js'].concat(
      this._options.extensions || [],
    );
    if (defaultPlatform) {
      exts = ['.' + defaultPlatform + '.js'].concat(exts);
    }

    // 0. If we have already resolved this module for this directory name,
    //    return a value from the cache.
    if (this._moduleNameCache[key]) {
      return this._moduleNameCache[key];
    }

    // 1. Check if the module is a haste module.
    let module = this.getModule(moduleName);
    if (module) {
      return this._moduleNameCache[key] = module;
    }

    // 2. Check if the module is a node module and resolve it based on
    //    the node module resolution algorithm.
    if (!options || !options.skipNodeResolution) {
      module = Resolver.findNodeModule(moduleName, {
        basedir: dirname,
        browser: this._options.browser,
        extensions: exts,
        moduleDirectory,
        paths,
      });

      if (module) {
        return this._moduleNameCache[key] = module;
      }
    }

    // 3. Resolve "haste packages" which are `package.json` files outside of
    // `node_modules` folders anywhere in the file system.
    const parts = moduleName.split('/');
    module = this.getPackage(parts.shift());
    if (module) {
      try {
        return this._moduleNameCache[key] = require.resolve(
          path.join.apply(path, [path.dirname(module)].concat(parts)),
        );
      } catch (ignoredError) {}
    }

    // 4. Throw an error if the module could not be found. `resolve.sync`
    //    only produces an error based on the dirname but we have the actual
    //    current module name available.
    const relativePath = path.relative(dirname, from);
    const err = new Error(
      `Cannot find module '${moduleName}' from '${relativePath || '.'}'`,
    );
    (err: any).code = 'MODULE_NOT_FOUND';
    throw err;
  }

  isCoreModule(moduleName: string): boolean {
    return this._options.hasCoreModules && resolve.isCore(moduleName);
  }

  getModule(name: string): ?Path {
    return this._moduleMap.getModule(
      name,
      this._options.defaultPlatform,
      this._supportsNativePlatform(),
    );
  }

  getPackage(name: string): ?Path {
    return this._moduleMap.getPackage(
      name,
      this._options.defaultPlatform,
      this._supportsNativePlatform(),
    );
  }

  getMockModule(from: Path, name: string): ?Path {
    const mock = this._moduleMap.getMockModule(name);
    if (mock) {
      return mock;
    } else {
      const moduleName = this._resolveStubModuleName(from, name);
      if (moduleName) {
        return this.getModule(moduleName) || moduleName;
      }
    }
    return null;
  }

  getModulePaths(from: Path): Array<Path> {
    if (!this._modulePathCache[from]) {
      const moduleDirectory = this._options.moduleDirectories;
      const paths = nodeModulesPaths(from, {moduleDirectory});
      if (paths[paths.length - 1] === undefined) {
        // circumvent node-resolve bug that adds `undefined` as last item.
        paths.pop();
      }
      this._modulePathCache[from] = paths;
    }
    return this._modulePathCache[from];
  }

  _resolveStubModuleName(from: Path, moduleName: string): ?Path {
    const dirname = path.dirname(from);
    const paths = this._options.modulePaths;
    const extensions = this._options.extensions;
    const moduleDirectory = this._options.moduleDirectories;

    const moduleNameMapper = this._options.moduleNameMapper;
    if (moduleNameMapper) {
      for (const mappedModuleName in moduleNameMapper) {
        const regex = moduleNameMapper[mappedModuleName];
        if (regex.test(moduleName)) {
          const matches = moduleName.match(regex);
          if (!matches) {
            moduleName = mappedModuleName;
          } else {
            moduleName = mappedModuleName.replace(
              /\$([0-9]+)/g,
              (_, index) => matches[parseInt(index, 10)],
            );
          }
          return this.getModule(moduleName) || Resolver.findNodeModule(
            moduleName,
            {
              basedir: dirname,
              browser: this._options.browser,
              extensions,
              moduleDirectory,
              paths,
            },
          );
        }
      }
    }
    return null;
  }

  _supportsNativePlatform() {
    return (this._options.platforms || []).indexOf(NATIVE_PLATFORM) !== -1;
  }

}

module.exports = Resolver;

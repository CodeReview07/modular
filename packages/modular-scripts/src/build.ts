// While working on this file, be aware that builds
// could be happening simultaneously across packages, so
// try be 'thread-safe'. No state outside of functions

// shorthand for building every workspace, if you're ever debugging this flow
// rm -rf dist && yarn modular build `ls -m1 packages | sed -e 'H;${x;s/\n/,/g;s/^,//;p;};d'`

import { JSONSchemaForNPMPackageJsonFiles as PackageJson } from '@schemastore/package';
import { JSONSchemaForTheTypeScriptCompilerSConfigurationFile as TSConfig } from '@schemastore/tsconfig';

import { promisify as prom } from 'util';

import * as rollup from 'rollup';
import rimraf from 'rimraf';
import * as path from 'path';
import { extract } from 'tar';

import execa from 'execa';

import postcss from 'rollup-plugin-postcss';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';

import * as ts from 'typescript';
import * as fse from 'fs-extra';

import builtinModules from 'builtin-modules';
import getModularRoot from './getModularRoot';

const modularRoot = getModularRoot();

if (process.cwd() !== modularRoot) {
  throw new Error(
    'This command can only be run from the root of a modular project',
  );
}

type Console = {
  log: typeof console.log;
  error: typeof console.error;
};

const consoles: { [name: string]: Console } = {};

function getConsole(directoryName: string): Console {
  if (!consoles[directoryName]) {
    consoles[directoryName] = {
      log: (...args: Parameters<typeof console.log>) => {
        return console.log('$ ' + directoryName + ':', ...args);
      },
      error: (...args: Parameters<typeof console.error>) => {
        return console.error('$ ' + directoryName + ':', ...args);
      },
    };
  }
  return consoles[directoryName];
}

// from https://github.com/Microsoft/TypeScript/issues/6387
// a helper to output a readable message from a ts diagnostics object
function reportTSDiagnostics(
  directoryName: string,
  diagnostics: ts.Diagnostic[],
): void {
  diagnostics.forEach((diagnostic) => {
    let message = 'Error';
    if (diagnostic.file) {
      const where = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start as number,
      );
      message += ` ${diagnostic.file.fileName} ${where.line}, ${
        where.character + 1
      }`;
    }
    message +=
      ': ' + ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    console.log(message);
  });
}

const extensions = ['.ts', '.tsx', '.js', '.jsx'];
const outputDirectory = 'dist';
const typescriptConfigFilename = 'tsconfig.json';
const packagesRoot = 'packages';

// list of all directories under packages
const packageDirectoryNames = fse
  .readdirSync(packagesRoot, { withFileTypes: true })
  .filter((directoryEntry) => directoryEntry.isDirectory())
  .map((directory) => directory.name);

// dependencies defined at the root
const rootPackageJsonDependencies =
  (fse.readJSONSync('package.json') as PackageJson).dependencies || {};

// a map of all package.json contents, indexed by package name
const packageJsons: { [key: string]: PackageJson } = {};
// a map of all package.json contents, indexed by directory name
const packageJsonsByDirectoryName: {
  [key: string]: PackageJson;
} = {};
// an array of all the package names
const packageNames: string[] = [];

// let's populate the above three
for (let i = 0; i < packageDirectoryNames.length; i++) {
  const pathToPackageJson = path.join(
    packagesRoot,
    packageDirectoryNames[i],
    'package.json',
  );
  if (fse.existsSync(pathToPackageJson)) {
    const packageJson = fse.readJsonSync(pathToPackageJson) as PackageJson;
    if (!packageJson.name) {
      continue;
    }
    packageJsons[packageJson.name] = packageJson;
    packageJsonsByDirectoryName[packageDirectoryNames[i]] = packageJson;
    packageNames.push(packageJson.name);
  }
}

// TODO: do a quick check to make sure workspaces aren't
// explicitly included in dependencies
// maybe that belongs in `modular check`

const publicPackageJsons: {
  [name: string]: PackageJson;
} = {};

function distinct<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

const typescriptConfig: TSConfig = {};
// validate tsconfig
{
  // Extract configuration from config file and parse JSON,
  // after removing comments. Just a fancier JSON.parse
  const result = ts.parseConfigFileTextToJson(
    typescriptConfigFilename,
    fse.readFileSync(typescriptConfigFilename, 'utf8').toString(),
  );

  const configObject = result.config as TSConfig;

  if (!configObject) {
    reportTSDiagnostics(':root', [result.error as ts.Diagnostic]);
    throw new Error('Failed to load Typescript configuration');
  }

  // Casting to a variable so that configObject.exclude is set to the correct typing
  // Since configObject is a index type all values are "any" implicitly.
  const exclude: string[] = (configObject.exclude as string[]) || [];

  Object.assign(typescriptConfig, configObject, {
    // TODO: should probably include the original exclude in this
    exclude: distinct([
      // all TS test files, regardless whether co-located or in test/ etc
      '**/*.stories.ts',
      '**/*.stories.tsx',
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/*.e2e.ts',
      '**/*.spec.tsx',
      '**/*.test.tsx',
      '__tests__',
      '**/dist-cjs',
      '**/dist-es',
      '**/dist-types',
      // TS defaults below
      'node_modules',
      'bower_components',
      'jspm_packages',
      'tmp',
      ...exclude,
    ]),
  });

  typescriptConfig.compilerOptions = typescriptConfig.compilerOptions || {};

  Object.assign(typescriptConfig.compilerOptions, {
    declarationDir: outputDirectory,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    incremental: false,
  });
}

async function makeBundle(
  directoryName: string,
  preserveModules: boolean,
): Promise<boolean> {
  const console = getConsole(directoryName);

  const packageJson = packageJsonsByDirectoryName[directoryName];

  if (!packageJson) {
    throw new Error(
      `no package.json in ${packagesRoot}/${directoryName}, bailing...`,
    );
  }
  if (packageJson.private === true) {
    throw new Error(
      `${packagesRoot}/${directoryName} is marked private, bailing...`,
    );
  }
  if (!packageJson.main) {
    throw new Error(
      `package.json at ${packagesRoot}/${directoryName} does not have a "main" field, bailing...`,
    );
  }

  if (
    !fse.existsSync(path.join(packagesRoot, directoryName, packageJson.main))
  ) {
    throw new Error(
      `package.json at ${packagesRoot}/${directoryName} does not have a "main" field that points to an existing source file, bailing...`,
    );
  }

  if (!packageJson.name) {
    throw new Error(
      `package.json at ${packagesRoot}/${directoryName} does not have a valid "name", bailing...`,
    );
  }

  if (!packageJson.version) {
    throw new Error(
      `package.json at ${packagesRoot}/${directoryName} does not have a valid "version", bailing...`,
    );
  }

  if (packageJson.module) {
    throw new Error(
      `package.json at ${packagesRoot}/${directoryName} shouldn't have a "module" field, bailing...`,
    );
  }

  if (packageJson.typings) {
    throw new Error(
      `package.json at ${packagesRoot}/${directoryName} shouldn't have a "typings" field, bailing...`,
    );
  }

  console.log(`building ${packageJson.name} at packages/${directoryName}...`);

  const bundle = await rollup.rollup({
    input: path.join(packagesRoot, directoryName, packageJson.main),
    external: (id) => {
      // via tsdx
      // TODO: this should probably be included into deps instead
      if (id === 'babel-plugin-transform-async-to-promises/helpers') {
        // we want to inline these helpers
        return false;
      }
      // exclude any dependency that's not a realtive import
      return !id.startsWith('.') && !path.isAbsolute(id);
    },
    treeshake: {
      // via tsdx: Don't use getters and setters on plain objects.
      propertyReadSideEffects: false,
    },
    plugins: [
      resolve({
        extensions,
        browser: true,
        mainFields: ['module', 'main', 'browser'],
      }),
      commonjs({ include: /\/node_modules\// }),
      babel({
        babelHelpers: 'bundled',
        presets: [
          ['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
          '@babel/preset-react',
          [
            '@babel/preset-env',
            // TODO: why doesn't this read `targets` from package.json?
          ],
        ],
        plugins: ['@babel/plugin-proposal-class-properties'],
        extensions,
        include: [`${packagesRoot}/**/*`],
        exclude: 'node_modules/**',
      }),
      postcss({ extract: false, modules: true }),
      // TODO: add sass, css modules, dotenv
      json(),
      {
        // via tsdx
        // Custom plugin that removes shebang from code because newer
        // versions of bublé bundle their own private version of `acorn`
        // and I don't know a way to patch in the option `allowHashBang`
        // to acorn. Taken from microbundle.
        // See: https://github.com/Rich-Harris/buble/pull/165
        name: 'strip-shebang',
        transform(code) {
          code = code.replace(/^#!(.*)/, '');

          return {
            code,
            map: null,
          };
        },
      },
    ],
    // TODO: support for css modules, sass, dotenv,
    // and anything else create-react-app supports
    // (alternatively, disable support for those in apps)
  });

  const outputOptions = {
    freeze: false,
    sourcemap: true, // TODO: read this off env
  };

  // we're going to use bundle.write() to actually generate the
  // output files, but first we're going to do a scan
  // to validate dependencies and collect some metadata for later
  const { output } = await bundle.generate(outputOptions);
  // TODO: we should use this loop to generate the files itself
  // to avoid the second scan, but it's ok for now I guess.

  // "local" workspaces/packages that were imported, i.e - packages/*
  const localImports: { [name: string]: string } = {};

  // this is used to collect local filenames being referenced
  // to prevent errors where facades are imported as dependencies
  // and are collected in missingDependencies
  const localFileNames = new Set<string>();

  // imports that aren't defined in package.json or root package.json
  // Now, this will also mark dependencies that were transient/nested,
  // but I think that's the right choice; a dependency might remove it,
  // even in a patch, and it'll break your code and you wouldn't know why.
  const missingDependencies: Set<string> = new Set();

  for (const chunkOrAsset of output) {
    if (chunkOrAsset.type === 'asset') {
      // TODO: what should happen here?
    } else {
      // it's a 'chunk' of source code, let's analyse it
      for (const imported of [
        ...chunkOrAsset.imports,
        ...chunkOrAsset.dynamicImports,
      ]) {
        // get the dependency (without references any inner modules)
        const importedPath = imported.split('/');
        const importedPackage =
          // scoped package?
          importedPath[0][0] === '@'
            ? `${importedPath[0]}/${importedPath[1]}`
            : // non-scoped
              importedPath[0];

        if (
          importedPackage !== imported &&
          packageNames.includes(importedPackage) &&
          // it's fine if it's anything but a js file
          extensions.includes(path.extname(imported))
        ) {
          // TODO: revisit this if and when we have support for multiple entrypoints
          // TODO: add a line number and file name here
          console.error(
            `cannot import a submodule ${imported} from ${importedPackage}`,
          );
          // TODO: This could probably be an error, but
          // let's revisit it when we have a better story.
        }

        if (packageJsons[importedPackage]) {
          // This means we're importing from a local workspace
          // Let's collect the name and add it in the package.json
          // we publish to the registry
          // TODO: make sure local workspaces are NOT explicitly included in package.json
          if (packageJsons[importedPackage].private !== true) {
            localImports[importedPackage] = packageJsons[importedPackage]
              .version as string;
          } else {
            throw new Error(
              `referencing a private package: ${importedPackage}`,
            ); // TODO - lineNo, filename
          }
        } else {
          // remote
          if (
            // not mentioned in the local package.json
            !packageJson.dependencies?.[importedPackage] &&
            !packageJson.peerDependencies?.[importedPackage]
          ) {
            if (rootPackageJsonDependencies[importedPackage]) {
              localImports[importedPackage] =
                rootPackageJsonDependencies[importedPackage];
            } else {
              // not mentioned in the root package.json either, so
              // let's collect its name and throw an error later
              // TODO: if it's in root's dev dependencies, should throw a
              // different kind of error
              if (!builtinModules.includes(importedPackage)) {
                // save filename to remove from missingDeps later
                // if they exist there
                localFileNames.add(chunkOrAsset.fileName);
                missingDependencies.add(importedPackage);
              }
            }
          }
        }
      }
    }
  }

  if (Object.keys(localImports).length > 0) {
    console.log('Adding dependencies to the generated package.json:');
    console.log(localImports);
  }

  // remove local filenames from missingDependencies
  const missingDependenciesWithoutLocalFileNames = [
    ...missingDependencies,
  ].filter((dep) => !localFileNames.has(dep));

  if (missingDependenciesWithoutLocalFileNames.length > 0) {
    throw new Error(
      `Missing dependencies: ${missingDependenciesWithoutLocalFileNames.join(
        ', ',
      )};`, // TODO: lineNo, filename
    );
  }

  // now actually write the bundles to disk
  // TODO: write to disk in the above check itself to prevent this 2nd pass

  await bundle.write({
    ...outputOptions,
    ...(preserveModules
      ? {
          preserveModules: true,
          dir: path.join(packagesRoot, directoryName, `${outputDirectory}-cjs`),
        }
      : {
          file: path.join(
            packagesRoot,
            directoryName,
            `${outputDirectory}-cjs`,
            directoryName + '.cjs.js',
          ),
        }),
    format: 'cjs',
    exports: 'auto',
  });

  await bundle.write({
    ...outputOptions,
    ...(preserveModules
      ? {
          preserveModules: true,
          dir: path.join(packagesRoot, directoryName, `${outputDirectory}-es`),
        }
      : {
          file: path.join(
            packagesRoot,
            directoryName,
            `${outputDirectory}-es`,
            directoryName + '.es.js',
          ),
        }),
    format: 'es',
    exports: 'auto',
  });

  // store the public facing package.json that we'll write to disk later
  publicPackageJsons[directoryName] = {
    ...packageJson,
    // TODO: what of 'bin' fields?
    main: preserveModules
      ? path.join(
          `${outputDirectory}-cjs`,
          packageJson.main
            .replace(/\.tsx?$/, '.js')
            .replace(path.dirname(packageJson.main) + '/', ''),
        )
      : `${outputDirectory}-cjs/${directoryName + '.cjs.js'}`,
    module: preserveModules
      ? path.join(
          `${outputDirectory}-es`,
          packageJson.main
            .replace(/\.tsx?$/, '.js')
            .replace(path.dirname(packageJson.main) + '/', ''),
        )
      : `${outputDirectory}-es/${directoryName + '.es.js'}`,
    typings: path.join(
      `${outputDirectory}-types`,
      packageJson.main.replace(/\.tsx?$/, '.d.ts'),
    ),
    dependencies: {
      ...packageJson.dependencies,
      ...localImports,
    },
    files: distinct([
      ...(packageJson.files || []),
      '/dist-cjs',
      '/dist-es',
      '/dist-types',
      'README.md',
    ]),
  };

  console.log(`built ${directoryName}`);
  return true;
}

function makeTypings(directoryName: string) {
  const console = getConsole(directoryName);

  console.log('generating .d.ts files for', directoryName);

  // make a shallow copy of the configuration
  const tsconfig: TSConfig = {
    ...typescriptConfig,
    compilerOptions: {
      ...typescriptConfig.compilerOptions,
    },
  };

  // then add our custom stuff

  // Only include src files from the package to prevent already built
  // files from interferring with the compile
  tsconfig.include = [`${packagesRoot}/${directoryName}/src`];
  tsconfig.compilerOptions = {
    ...tsconfig.compilerOptions,
    declarationDir: `${packagesRoot}/${directoryName}/${outputDirectory}-types`,
    rootDir: `${packagesRoot}/${directoryName}`,
  };

  // Extract config information
  const configParseResult = ts.parseJsonConfigFileContent(
    tsconfig,
    ts.sys,
    path.dirname(typescriptConfigFilename),
  );

  if (configParseResult.errors.length > 0) {
    reportTSDiagnostics(directoryName, configParseResult.errors);
    throw new Error('Could not parse Typescript configuration');
  }

  const host = ts.createCompilerHost(configParseResult.options);
  host.writeFile = (fileName, contents) => {
    fse.mkdirpSync(path.dirname(fileName));
    fse.writeFileSync(fileName, contents);
  };

  // Compile
  const program = ts.createProgram(
    configParseResult.fileNames,
    configParseResult.options,
    host,
  );

  const emitResult = program.emit();

  // Report errors
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emitResult.diagnostics);
  if (diagnostics.length > 0) {
    reportTSDiagnostics(directoryName, diagnostics);
    throw new Error('Could not generate .d.ts files');
  }
}

export async function build(
  directoryName: string,
  preserveModules = false,
): Promise<void> {
  const console = getConsole(directoryName);
  // ensure the root build folder is ready
  await fse.mkdirp(outputDirectory);

  // delete any existing local build folders
  await prom(rimraf)(
    path.join(packagesRoot, directoryName, `${outputDirectory}-cjs`),
  );
  await prom(rimraf)(
    path.join(packagesRoot, directoryName, `${outputDirectory}-es`),
  );
  await prom(rimraf)(
    path.join(packagesRoot, directoryName, `${outputDirectory}-types`),
  );

  // generate the js files
  const didBundle = await makeBundle(directoryName, preserveModules);
  if (!didBundle) {
    return;
  }
  // then the .d.ts files
  makeTypings(directoryName);

  const originalPkgJsonContent = (await fse.readJson(
    path.join(packagesRoot, directoryName, 'package.json'),
  )) as PackageJson;

  // switch in the special package.json
  try {
    await fse.writeJson(
      path.join(packagesRoot, directoryName, 'package.json'),
      publicPackageJsons[directoryName],
      { spaces: 2 },
    );

    await execa(
      'yarnpkg',
      // TODO: verify this works on windows
      [
        'pack',
        '--filename',
        path.join(`../../${outputDirectory}`, directoryName + '.tgz'),
      ],
      {
        cwd: packagesRoot + '/' + directoryName,
        stdin: process.stdin,
        stderr: process.stderr,
        stdout: process.stdout,
      },
    );
  } finally {
    // now revert package.json
    await fse.writeJson(
      path.join(packagesRoot, directoryName, 'package.json'),
      originalPkgJsonContent,
      { spaces: 2 },
    );
  }

  // cool. now unpack the tgz's contents in the root dist
  await fse.mkdirp(path.join(outputDirectory, directoryName));

  await extract({
    file: path.join(outputDirectory, directoryName + '.tgz'),
    strip: 1,
    C: path.join(outputDirectory, directoryName),
  });

  // (if you're curious why we unpack it here, it's because
  // we observed problems with publishing tgz files directly to npm.)

  // delete the local dist folders
  await prom(rimraf)(
    path.join(packagesRoot, directoryName, `${outputDirectory}-cjs`),
  );
  await prom(rimraf)(
    path.join(packagesRoot, directoryName, `${outputDirectory}-es`),
  );
  await prom(rimraf)(
    path.join(packagesRoot, directoryName, `${outputDirectory}-types`),
  );

  // then delete the tgz
  await fse.remove(path.join(outputDirectory, directoryName + '.tgz'));
  /// and... that's it
  console.log('finished');
}

/* TODO:

- build command
  - rm -rf dist && yarn modular build create-modular-react-app,modular-scripts --preserve-modules && yarn workspace modular-views.macro build
- cleanup local dist folders on errors
- read preset-env targets from package.json
  - also, if something _does_ need regenerator, how do we add it as a dep?
- package.json should be able to specify build arguments. Specifically:
  - preserveModules: boolean
  - preserveEntrySignatures:  "strict" | "allow-extension" | "exports-only" | false
- should we disallow using __dirname/__filename in libraries?
- how do we deal with bin fields? maybe inside a standalone bin file,
  we can read package.json's main field?? That could be clever.
- rewrite modular-views.macro with typescript
- how does this work with changesets?
- some kind of build info would be helpful? eg: https://unpkg.com/browse/react@17.0.1/build-info.json
- can we run tests on our built versions? to verify we haven't broken anything.
*/

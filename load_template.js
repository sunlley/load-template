'use strict';

const https = require('https');
const os = require('os');
const path = require('path');
const fs = require("fs-extra");
const commander = require("commander");
const packageJson = require("./package.json");
const chalk = require("chalk");
const envinfo = require("envinfo");
const semver = require("semver");
const validateProjectName = require("validate-npm-package-name");
const prompts = require("prompts");
const hyperquest = require("hyperquest");
const {unpack} = require("tar-pack");
const spawn = require("cross-spawn");
const tmp = require("tmp");
const debug = require("semver/internal/debug");
const PACKAGE_BLACKLIST = [
    'name',
    'version',
    'description',
    'keywords',
    'bugs',
    'license',
    'author',
    'contributors',
    'files',
    'browser',
    'bin',
    'man',
    'directories',
    'repository',
    'peerDependencies',
    'bundledDependencies',
    'optionalDependencies',
    'engineStrict',
    'os',
    'cpu',
    'preferGlobal',
    'private',
    'publishConfig',
];

let isDebug=false;
const debugLog = (...args) => {
    if (isDebug){
        console.log( chalk.bgBlue('[DEBUG LOG]'),new Date(),...args)
    }
}

const extractStream = (stream, dest) => {
    return new Promise((resolve, reject) => {
        stream.pipe(
            unpack(dest, err => {
                if (err) {
                    reject(err);
                } else {
                    resolve(dest);
                }
            })
        );
    });

}
const getTemporaryDirectory = () => {
    return new Promise((resolve, reject) => {
        // Unsafe cleanup lets us recursively delete the directory if it contains
        // contents; by default it only allows removal if it's empty
        tmp.dir({unsafeCleanup: true}, (err, tmpdir, callback) => {
            if (err) {
                reject(err);
            } else {
                resolve({
                    tmpdir: tmpdir,
                    cleanup: () => {
                        try {
                            callback();
                        } catch (ignored) {
                            // Callback might throw and fail, since it's a temp directory the
                            // OS will clean it up eventually...
                        }
                    },
                });
            }
        });
    });
}

const check_client_version = async (packagename) => {
    return new Promise((resolve, reject) => {
        https.get(
            `https://registry.npmjs.org/-/package/${packagename}/dist-tags`,
            res => {
                if (res.statusCode === 200) {
                    let body = '';
                    res.on('data', data => (body += data));
                    res.on('end', () => {
                        resolve(JSON.parse(body).latest);
                    });
                } else {
                    reject(new Error('Http error:' + res.statusCode));
                }
            }
        ).on('error', () => {
            reject(new Error(`Http error: check client version request failed with ${packagename}`));
        });
    });
}
const check_node_version = (version) => {
    const target_version = '18';
    debugLog('check node version',`local(${version})|target(${target_version})`)
    const unsupportedNodeVersion = !semver.satisfies(
        // Coerce strings with metadata (i.e. `15.0.0-nightly`).
        semver.coerce(version),
        `>=${target_version}`
    );
    if (unsupportedNodeVersion) {
        console.log(
            chalk.yellow(
                `You are using Node ${process.version} so the project will be bootstrapped with an old unsupported version of tools.\n\n` +
                `Please update to Node ${target_version} or higher for a better, fully supported experience.\n`
            )
        );
        // Fall back to latest supported react-scripts on Node 4
        process.exit(1);
    }
}
const check_node_support = (packageName) => {
    const packageJsonPath = path.resolve(
        process.cwd(),
        'node_modules',
        packageName,
        'package.json'
    );

    if (!fs.existsSync(packageJsonPath)) {
        return;
    }

    const packageJson = require(packageJsonPath);
    if (!packageJson.engines || !packageJson.engines.node) {
        return;
    }

    if (!semver.satisfies(process.version, packageJson.engines.node)) {
        console.error(
            chalk.red(
                'You are running Node %s.\n' +
                'Create React App requires Node %s or higher. \n' +
                'Please update your version of Node.'
            ),
            process.version,
            packageJson.engines.node
        );
        process.exit(1);
    }
}
const check_project = (name, root, cover) => {
    const validationResult = validateProjectName(name);
    if (!validationResult.validForNewPackages) {
        console.error(
            chalk.red(
                `Cannot create a project named ${chalk.green(
                    `"${name}"`
                )} because of npm naming restrictions:\n`
            )
        );
        [
            ...(validationResult.errors || []),
            ...(validationResult.warnings || []),
        ].forEach(error => {
            console.error(chalk.red(`  * ${error}`));
        });
        console.error(chalk.red('\nPlease choose a different project name.'));
        process.exit(1);
    }
    let result = fs.pathExistsSync(root)
    // console.log('pathExistsSync', result);
    if (result) {
        if (cover) {
            console.log(`  * ${chalk.green('remove old project')}`)
            fs.removeSync(root);
        } else {
            console.error(
                chalk.red(
                    `Cannot create a project named ${chalk.green(
                        `"${name}"`
                    )} because of path exists  ${chalk.red('\nPlease choose a different project name.')}`
                )
            );
            process.exit(1);
        }
    }
}

const get_package_info = (installPackage,type) => {
    return new Promise((resolve, reject) => {
        debugLog('get_package_info','start', installPackage);

        if (installPackage.match(/^.+\.(tgz|tar\.gz)$/)) {
            return getTemporaryDirectory()
                .then(obj => {
                    let stream;
                    if (/^http/.test(installPackage)) {
                        stream = hyperquest(installPackage);
                    } else {
                        stream = fs.createReadStream(installPackage);
                    }
                    return extractStream(stream, obj.tmpdir).then(() => obj);
                })
                .then(obj => {
                    const {name, version} = require(path.join(
                        obj.tmpdir,
                        'package.json'
                    ));
                    obj.cleanup();
                    resolve({name, version})
                })
                .catch(err => {
                    // The package name could be with or without semver version, e.g. react-scripts-0.2.0-alpha.1.tgz
                    // However, this function returns package name only without semver version.
                    console.log(
                        `Could not extract the package name from the archive: ${err.message}`
                    );
                    const assumedProjectName = installPackage.match(
                        /^.+\/(.+?)(?:-\d+.+)?\.(tgz|tar\.gz)$/
                    )[1];
                    console.log(
                        `Based on the filename, assuming it is "${chalk.cyan(
                            assumedProjectName
                        )}"`
                    );
                    return resolve({name: assumedProjectName});
                });
        } else if (installPackage.startsWith('git+')) {
            // Pull package name out of git urls e.g:
            // git+https://github.com/mycompany/react-scripts.git
            // git+ssh://github.com/mycompany/react-scripts.git#v1.2.3
            return resolve({
                name: installPackage.match(/([^/]+)\.git(#.*)?$/)[1],
            });
        } else if (installPackage.match(/.+@/)) {
            // Do not match @scope/ when stripping off @version or @tag
            return resolve({
                name: installPackage.charAt(0) + installPackage.substr(1).split('@')[0],
                version: installPackage.split('@')[1],
            });
        } else if (installPackage.match(/^file:/)) {
            const installPackagePath = installPackage.match(/^file:(.*)?$/)[1];
            const {name, version} = require(path.join(
                installPackagePath,
                'package.json'
            ));
            return resolve({name, version});
        } else {
            https.get(`https://registry.npmjs.org/${installPackage}`,
                res => {
                    if (res.statusCode === 200) {
                        let body = '';
                        res.on('data', data => (body += data));
                        res.on('end', () => {
                            let result = JSON.parse(body);
                            resolve({name: installPackage, version: result.latest});
                        });
                    } else {
                        resolve({name: installPackage});
                    }
                })
                .on('error', () => {
                    // reject();
                    resolve({name: installPackage});
                });
        }
    });
}
const get_template_name = (template, directory) => {
    debugLog('get_template_name','start', template, directory);
    let _template=template;
    let name='cra-template-liaapi-ts';
    let type='http';
    if (template) {
        if (template.match(/^file:/)) {
            template = template.replace('file:','')
            let data = fs.readFileSync(path.resolve(template,'package.json'), 'utf8');
            data = JSON.parse(data);
            name = data.name;
            type='file';
        } else if (
            template.includes('://') ||
            template.match(/^.+\.(tgz|tar\.gz)$/)
        ) {
            name=template;
            type='http';
            // for tar.gz or alternative paths
        } else {
            if (template.indexOf('cra-template-') >= 0) {
                name = template;
                type='http';
            } else {
                name = `cra-template-${template}`;
                type='http';
            }

        }
    }
    debugLog('get_template_name','done', name, type);
    return Promise.resolve({name, type,value:_template});
}
/**
 *
 * @param root
 * @param language
 * @param isPrivate
 * @returns {{appName: string, packageJson: {private, devDependencies: {}, name: string, eslintConfig: {extends: *[]}, version: string, dependencies: {}}, tsconfigJson: {include: string[], exclude: string[], compilerOptions: {experimentalDecorators: boolean, types: string[], declarationDir: string, lib: string[], sourceMap: boolean, module: string, allowSyntheticDefaultImports: boolean, importHelpers: boolean, rootDir: string, resolveJsonModule: boolean, declaration: boolean, jsx: string, target: string, esModuleInterop: boolean, outDir: string, baseUrl: string, skipLibCheck: boolean, moduleResolution: string, strict: boolean}}}}
 */
const check_default_json = (root, language, isPrivate) => {
    const appName = path.basename(root);
    let packageJson = {
        name: appName,
        version: '0.1.0',
        private: isPrivate,
        devDependencies: {},
        dependencies: {},
        eslintConfig: {
            "extends": []
        }
    }
    let tsconfigJson;
    if (language === 'ts') {
        packageJson.devDependencies = {
            // "@types/node": "^22.1.0",
            // "nodemon": "^3.1.4",
            // "ts-node": "^10.9.2",
            // "tslib": "^2.6.3",
            // "typescript": "^5.5.4"
        }
        tsconfigJson = {
            "compilerOptions": {
                "experimentalDecorators": true,
                "module": "CommonJS",
                "target": "es2020",
                "strict": true,
                "jsx": "preserve",
                "importHelpers": true,
                "moduleResolution": "node",
                "skipLibCheck": true,
                "esModuleInterop": true,
                "allowSyntheticDefaultImports": true,
                "sourceMap": true,
                "baseUrl": ".",
                "outDir": "./output",
                "rootDir": ".",
                "types": [
                    "webpack-env",
                    "node"
                ],
                "resolveJsonModule": true,
                "declaration": true,// 是否生成声明文件
                "declarationDir": "dist/type",// 声明文件打包的位置
                "lib": [
                    "esnext",
                    "es5",
                    "ES2016",
                    "ES2020",
                    "dom",
                    "dom.iterable",
                    "scripthost"
                ]
            },
            "include": [
                "__test__",
                "src",
                "src/**/*",
                "global.d.ts"
            ],
            "exclude": [
                "node_modules"
            ]
        };
        // fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfigJson, null, 2) + os.EOL);
    }
    debugLog('check_default_json',language)
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2) + os.EOL);
    return {
        appName, packageJson, tsconfigJson
    };
}
const move_template = (appPath, templateName) => {
    debugLog('move_template',templateName)
    const appPackage = require(path.join(appPath, 'package.json'));
    const templatePath = path.dirname(require.resolve(`${templateName}/package.json`, {paths: [appPath]}));
    const templateTemplateJsonPath = path.join(templatePath, 'template.json');
    const templatePackageJsonPath = path.join(templatePath, 'template', 'package.json');

    // console.log('move_template','templateJsonPath',chalk.green(templateTemplateJsonPath))
    // console.log('move_template','packageJsonPath ',chalk.green(templatePackageJsonPath))
    // console.log('move_template','appPackage      ',appPackage)

    // return
    let finalPackageJson = {...appPackage}
    let devDependencies = {};
    let dependencies = {};
    let scripts = {...(appPackage.scripts ?? {})};
    // console.log('move_template','scripts   ',scripts)
    let templateJson = {};
    if (fs.existsSync(templateTemplateJsonPath)) {
        templateJson = require(templateTemplateJsonPath);
    }
    if (fs.existsSync(templatePackageJsonPath)) {
        let json = require(templatePackageJsonPath);
        finalPackageJson = {
            ...json,
            ...appPackage,
        }
        devDependencies = {
            ...devDependencies,
            ...(json.devDependencies ?? {})
        }
        dependencies = {
            ...dependencies,
            ...(json.dependencies ?? {})
        }
        scripts = {
            ...scripts,
            ...(json.scripts ?? {})
        }
    }
    const templatePackage = templateJson.package;
    if (!templatePackage) {
        console.log(
            chalk.yellow(
                'Root-level `dependencies` and `scripts` keys in `template.json` were deprecated for Create React App 5.\n'
            )
        );
        console.log('For more information, visit https://cra.link/templates');

    } else {
        devDependencies = {
            ...devDependencies,
            ...(templatePackage.devDependencies ?? {})
        }
        dependencies = {
            ...dependencies,
            ...(templatePackage.dependencies ?? {})
        }
        scripts = {
            ...scripts,
            ...(templatePackage.scripts ?? {})
        }
        Object.keys(templatePackage)
            .filter((key) => PACKAGE_BLACKLIST.indexOf(key) < 0)
            .forEach((key) => {
                finalPackageJson[key] = templatePackage[key];
            })
    }
    finalPackageJson.scripts = scripts;
    finalPackageJson.dependencies = {}
    finalPackageJson.devDependencies = {};
    Object.keys(dependencies).sort().forEach((key) => {
        finalPackageJson.dependencies[key] = dependencies[key];
    })
    Object.keys(devDependencies).sort().forEach((key) => {
        finalPackageJson.devDependencies[key] = devDependencies[key];
    })
    fs.writeFileSync(path.join(appPath, 'package.json'), JSON.stringify(finalPackageJson, null, 2) + os.EOL);

    // Copy the files for the user
    const templateDir = path.join(templatePath, 'template');
    if (fs.existsSync(templateDir)) {
        fs.copySync(templateDir, appPath, {
            filter: (file) => {
                // console.log('copySync filter',file)
                if (file.endsWith('package.json')) {
                    return false;
                }
                if (file.endsWith('README.md')) {
                    return false;
                }
                return true;
            }
        });
    } else {
        console.error(
            `Could not locate supplied template: ${chalk.green(templateDir)}`
        );
        process.exit(1);
    }
    const readmeExists = fs.existsSync(path.join(templateDir, 'README.md'));
    if(readmeExists){
        let data = fs.readFileSync(path.join(templateDir, 'README.md'),'utf-8');
        fs.removeSync(path.join(appPath, 'README.md'));
        fs.writeFileSync(path.join(appPath, 'README.md'),data.replace("${appName}",appPackage.name));
    }
    const npmignoreExists = fs.existsSync(path.join(templateDir, 'npmignore'));
    if (npmignoreExists) {
        fs.writeFileSync(path.join(appPath, '.npmignore'), fs.readFileSync(path.join(appPath, 'npmignore'), 'utf8'));
        fs.removeSync(path.join(appPath, 'npmignore'));
    }
    const gitignoreExists = fs.existsSync(path.join(templateDir, 'gitignore'));
    if (!gitignoreExists) {
        fs.writeFileSync(path.join(appPath, '.gitignore'), `
# See https://help.github.com/articles/ignoring-files/ for more about ignoring files.

# dependencies
/node_modules

# testing
/coverage

# production
/build/
/lib/
/dist/
/cache/
/logs/
/output/
/build
/lib
/dist
/cache
/logs
/output


# misc
.idea
.DS_Store
package-lock.json

npm-debug.log*
yarn-debug.log*
yarn-error.log*

        `)
    }else {
        fs.writeFileSync(path.join(appPath, '.gitignore'), fs.readFileSync(path.join(appPath, 'gitignore'), 'utf8'));
        fs.removeSync(path.join(appPath, 'gitignore'));
    }
    fs.removeSync(path.join(appPath, 'node_modules'));
    fs.removeSync(path.join(appPath, 'package-lock.json'));
    debugLog('move_template','done')

}


const install = (root, dependencies, verbose, loglevel) => {
    if (!loglevel) {
        loglevel = 'error'
    }
    return new Promise((resolve, reject) => {
        let command = 'npm';
        let args = [
            'install',
            '--no-audit', // https://github.com/facebook/create-react-app/issues/11174
            '--save',
            '--save-exact',
            '--loglevel',
            loglevel,
        ].concat(dependencies);
        if (verbose) {
            args.push('--verbose');
        }
        const child = spawn(command, args, {stdio: 'inherit'});
        child.on('close', code => {
            if (code !== 0) {
                reject({
                    command: `${command} ${args.join(' ')}`,
                });
                return;
            }
            resolve();
        });
    });
};
const execute_script = (root, template) => {
    return new Promise((resolve, reject) => {
        move_template(root, template)
        resolve()
    });
}
/**
 *
 * @param name
 * @param params
 */
const create_project = async (name, params) => {
    let {verbose, template, cover, language, private: isPrivate, loglevel} = params;
    const root = path.resolve(name);
    debugLog('create_project',chalk.green(root));
    check_project(name, root, cover);
    fs.ensureDirSync(name, {});
    console.log(`Creating a new Application in ${chalk.green(root)}.`);
    const originalDirectory = process.cwd();
    process.chdir(root);
    let {packageJson, appName} = check_default_json(root, language, isPrivate);
    let templateInfo= await get_template_name(template, originalDirectory);
    const dependencies = [...(Object.keys(packageJson.dependencies))];
    if (templateInfo.type==='http'){
        let templatePackageInfo = await get_package_info(templateInfo.value);
        debugLog('get_package_info','done', templatePackageInfo);
        dependencies.push(templatePackageInfo.name)
    }else {
        dependencies.push(templateInfo.value)
    }
    for (const dependency of dependencies) {
        if (dependency) {
            console.log(`      - ${chalk.cyan(dependency)}`)
        }
    }
    debugLog('install template dependencies',dependencies)

    console.log(`Installing template for temporary using ${chalk.cyan('npm')}.`)
    await install(root, dependencies, verbose, loglevel);
    // return
    await execute_script(root, templateInfo.name);
    const appPackage = require(path.join(root, 'package.json'));
    console.log(chalk.bgGreen(`😁 Success! `));
    console.log(`Created ${appName} at ${chalk.cyan(root)}`);
    console.log('Inside that directory, you can run several commands:');
    for (const scriptsKey in appPackage.scripts) {
        console.log(`    ${chalk.cyan(scriptsKey)}`);
    }
    console.log('-------------------------------')
    console.log(chalk.cyan(' - cd'), appName);
    console.log(chalk.cyan(' - npm install'));
    console.log(chalk.cyan(` - check the README.md`));
    console.log('-------------------------------')
    console.log(chalk.bgGreen('🥳 Happy coding!'));
    console.log();

}
const start = async () => {
    let projectName;
    const program = new commander.Command(packageJson.name)
        .version(packageJson.version)
        .argument('<project-directory>', 'project name')
        .action((project_directory) => {
            projectName = project_directory;
        })
        .option('--verbose', 'print additional logs')
        .option('--info', 'print environment debug info')
        .option('--template <path-to-template>', 'specify a template for the created project')
        .option('--use-pnp')
        .option('--language', 'Development language, value ts or js, default ts', 'ts')
        .option('--cover', 'If the project exists, a new one will be created and the old one will be overwritten')
        .option('--private', 'Is the project privately owned', true)
        .option('--loglevel', 'loglevel', 'error')
        .option('--debug', 'develop mode', false)
        .allowUnknownOption()
        .on('--help', () => {
            console.log(`    Only ${chalk.green('<project-directory>')} is required.`);
            console.log();
            console.log(`    A custom ${chalk.cyan('--template')} can be one of:`);
            console.log(`      - a custom template published on npm: ${chalk.green('cra-template-typescript')}`);
            console.log(`      - a local path relative to the current working directory: ${chalk.green('file:../my-custom-template')}`);
            console.log(`      - a .tgz archive: ${chalk.green('https://mysite.com/my-custom-template-0.8.2.tgz')}`);
            console.log(`      - a .tar.gz archive: ${chalk.green('https://mysite.com/my-custom-template-0.8.2.tar.gz')}`);
            console.log();
        })
        .parse(process.argv);
    const info = JSON.parse(await envinfo.run({
        System: ['OS', 'CPU'],
        Binaries: ['Node', 'npm']
    }, {showNotFound: true, duplicates: true, json: true}));
    const params = program.opts();
    if (!projectName) {
        process.exit(1);
    }
    let last = packageJson.version;
    isDebug=params.debug;
    if (!isDebug){
        last = await check_client_version('load-template');
    }
    await check_node_version(info.Binaries.Node.version);
    let message = `
    Project Information
      - ${'name'.padEnd(10, ' ')}  ${chalk.green(projectName)}
      - ${'client'.padEnd(10, ' ')}  ${chalk.green(last)}(remote) | ${chalk.green(packageJson.version)}(local)
      - ${'os'.padEnd(10, ' ')}  ${chalk.green(info.System.OS)}
      - ${'node'.padEnd(10, ' ')}  ${chalk.green(info.Binaries.Node.version)}
      - ${'npm'.padEnd(10, ' ')}  ${chalk.green(info.Binaries.npm.version)}`
    for (const paramsKey in params) {
        message += `  
      - ${paramsKey.padEnd(10, ' ')}  ${chalk.green(params[paramsKey])}`
    }
    console.log(message)
    const template = params.template ?? 'liaapi-ts';
    debugLog('template: ' + params.template);
    await create_project(projectName, {...params, template});
}

module.exports = {
    start
}
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

const move_template = (appPath,templateName) => {
    // console.log('move_template',chalk.green(appPath))
    // console.log('move_template',chalk.green(templateName))
    const appPackage = require(path.join(appPath, 'package.json'));
    const templatePath = path.dirname(
        require.resolve(`${templateName}/package.json`, { paths: [appPath] }));
    const templateJsonPath = path.join(templatePath, 'template.json');
    const templatePackageJsonPath = path.join(templatePath, 'template','src','package.json');
    // console.log('move_template','template.json',chalk.green(templateJsonPath))
    // console.log('move_template','package.json ',chalk.green(templatePackageJsonPath))
    // console.log('move_template','appPackage   ',appPackage)

    let finalPackageJson={
        ...appPackage
    }
    let devDependencies={
        ...(appPackage.devDependencies??{})
    };
    let dependencies={
        ...(appPackage.dependencies??{})
    };
    let scripts={
        ...(appPackage.scripts??{})
    };
    // console.log('move_template','scripts   ',scripts)


    let templateJson = {};
    if (fs.existsSync(templateJsonPath)) {
        templateJson = require(templateJsonPath);
    }
    if (templateJson.dependencies || templateJson.scripts) {
        console.log();
        console.log(
            chalk.red(
                'Root-level `dependencies` and `scripts` keys in `template.json` were deprecated for Create React App 5.\n' +
                'This template needs to be updated to use the new `package` key.'
            )
        );
        console.log('For more information, visit https://cra.link/templates');
    }
    const templatePackage = templateJson.package || {};
    if (fs.existsSync(templatePackageJsonPath)) {
        let json = require(templatePackageJsonPath);
        finalPackageJson={
            ...json,
            ...appPackage,
        }
        console.log('move_template','finalPackageJson2   ',finalPackageJson)
        devDependencies={
            ...devDependencies,
            ...(json.devDependencies??{})
        }
        dependencies={
            ...dependencies,
            ...(json.dependencies??{})
        }
        scripts = Object.assign(
            {
                ...scripts,
            },{
                ...(json.scripts??{})
            }
        )
    }
    devDependencies={
        ...devDependencies,
        ...(templatePackage.devDependencies??{})
    }
    dependencies={
        ...dependencies,
        ...(templatePackage.dependencies??{})
    }
    scripts = Object.assign({
            ...scripts,
        },{...(templatePackage.scripts??{})})
    finalPackageJson.scripts=scripts;
    let dependenciesKeys=Object.keys(dependencies).sort();
    let devDependenciesKeys=Object.keys(devDependencies).sort();
    finalPackageJson.dependencies={}
    finalPackageJson.devDependencies={};
    for (const dependenciesKey of dependenciesKeys) {
        finalPackageJson.dependencies[dependenciesKey]=dependencies[dependenciesKey];
    }
    for (const devDependenciesKey of devDependenciesKeys) {
        finalPackageJson.devDependencies[devDependenciesKey]=devDependencies[devDependenciesKey];
    }

    fs.writeFileSync(
        path.join(appPath, 'package.json'),
        JSON.stringify(finalPackageJson, null, 2) + os.EOL
    );

    const readmeExists = fs.existsSync(path.join(appPath, 'README.md'));
    if (readmeExists) {
        fs.renameSync(
            path.join(appPath, 'README.md'),
            path.join(appPath, 'README.old.md')
        );
    }

    // Copy the files for the user
    const templateDir = path.join(templatePath, 'template');
    if (fs.existsSync(templateDir)) {
        fs.copySync(templateDir, appPath,{
            filter:(file)=>{
                // console.log('copySync filter',file)
                if (file.endsWith('package.json')){
                    return  false;
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
    const gitignoreExists = fs.existsSync(path.join(appPath, '.gitignore'));
    if (gitignoreExists) {
        // Append if there's already a `.gitignore` file there
        const data = fs.readFileSync(path.join(appPath, 'gitignore'));
        fs.appendFileSync(path.join(appPath, '.gitignore'), data);
        fs.unlinkSync(path.join(appPath, 'gitignore'));
    } else {
        // Rename gitignore after the fact to prevent npm from renaming it to .npmignore
        // See: https://github.com/npm/npm/issues/1862
        fs.moveSync(
            path.join(appPath, '.gitignore'),
            []
        );
    }

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
            reject(new Error('Http error: check client version request failed'));
        });
    });
}
const check_node_version = (version) => {
    const target_version = '18';
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
const check_project = (name, root) => {
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
    console.log('pathExistsSync', result);
    if (result) {
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

const get_packagejson_info = () => {
    return {}
}
const get_package_info = (installPackage) => {
    return new Promise((resolve, reject) => {
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
            https
                .get(
                    `https://registry.npmjs.org/${installPackage}`,
                    res => {
                        if (res.statusCode === 200) {
                            let body = '';
                            res.on('data', data => (body += data));
                            res.on('end', () => {
                                let result = JSON.parse(body);
                                resolve({name: installPackage, version: result.latest});
                                // console.log(body)
                                // resolve(JSON.parse(body).latest);
                            });
                        } else {
                            resolve({name: installPackage});
                        }
                    }
                )
                .on('error', () => {
                    // reject();
                    resolve({name: installPackage});
                });
        }
    });
}
const get_package_from_normal = (version, directory) => {
    let packageToInstall = 'react-scripts';
    const validSemver = semver.valid(version);
    // console.log('validSemver', validSemver, 'version', version)
    // console.log('validSemver',validSemver)
    if (validSemver) {
        packageToInstall += `@${validSemver}`;
    } else if (version) {
        if (version[0] === '@' && !version.includes('/')) {
            packageToInstall += version;
        } else if (version.match(/^file:/)) {
            packageToInstall = `file:${path.resolve(
                directory,
                version.match(/^file:(.*)?$/)[1]
            )}`;
        } else {
            // for tar.gz or alternative paths
            packageToInstall = version;
        }
    }
    const scriptsToWarn = [
        {
            name: 'react-scripts-ts',
            message: chalk.yellow(
                `The react-scripts-ts package is deprecated. TypeScript is now supported natively in Create React App. You can use the ${chalk.green(
                    '--template typescript'
                )} option instead when generating your app to include TypeScript support. Would you like to continue using react-scripts-ts?`
            ),
        },
    ];

    for (const script of scriptsToWarn) {
        if (packageToInstall.startsWith(script.name)) {
            return prompts({
                type: 'confirm',
                name: 'useScript',
                message: script.message,
                initial: false,
            }).then(answer => {
                if (!answer.useScript) {
                    process.exit(0);
                }
                return packageToInstall;
            });
        }
    }

    return Promise.resolve(packageToInstall);
}
const get_package_from_template = (template, directory) => {
    // console.log('get_package_from_template','template',template)
    let templateToInstall = 'cra-template-liaapi-ts';
    if (template) {
        if (template.match(/^file:/)) {
            templateToInstall = `file:${path.resolve(
                directory,
                template.match(/^file:(.*)?$/)[1]
            )}`;
        } else if (
            template.includes('://') ||
            template.match(/^.+\.(tgz|tar\.gz)$/)
        ) {
            // for tar.gz or alternative paths
            templateToInstall = template;
        } else {
            if (template.indexOf('@')>=0){
                // Add prefix 'cra-template-' to non-prefixed templates, leaving any
                // @scope/ and @version intact.
                const packageMatch = template.match(/^(@[^/]+\/)?([^@]+)?(@.+)?$/);
                const scope = packageMatch[1] || '';
                const templateName = packageMatch[2] || '';
                const version = packageMatch[3] || '';
                console.log('get_package_from_template','packageMatch',packageMatch)
                if (
                    templateName === templateToInstall ||
                    templateName.startsWith(`${templateToInstall}-`)
                ) {
                    // Covers:
                    // - cra-template
                    // - @SCOPE/cra-template
                    // - cra-template-NAME
                    // - @SCOPE/cra-template-NAME
                    templateToInstall = `${scope}${templateName}${version}`;
                } else if (version && !scope && !templateName) {
                    // Covers using @SCOPE only
                    templateToInstall = `${version}/${templateToInstall}`;
                } else {
                    // Covers templates without the `cra-template` prefix:
                    // - NAME
                    // - @SCOPE/NAME
                    templateToInstall = `${scope}${templateToInstall}-${templateName}${version}`;
                }
            }else if (template.indexOf('cra-template-')>=0){
                templateToInstall = template;
            }else {
                templateToInstall = `cra-template-${template}`;
            }

        }
    }

    console.log('get_package_from_template',chalk.green(templateToInstall))
    return Promise.resolve(templateToInstall);

}
const set_caret_range = (dependencies, name) => {
    const version = dependencies[name];

    if (typeof version === 'undefined') {
        console.error(chalk.red(`Missing ${name} dependency in package.json`));
        process.exit(1);
    }

    let patchedVersion = `^${version}`;

    if (!semver.validRange(patchedVersion)) {
        console.error(
            `Unable to patch ${name} dependency version because version ${chalk.red(
                version
            )} will become invalid ${chalk.red(patchedVersion)}`
        );
        patchedVersion = version;
    }

    dependencies[name] = patchedVersion;
}
const set_deps_for_runtime = (packageName) => {
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJson = require(packagePath);

    if (typeof packageJson.dependencies === 'undefined') {
        console.error(chalk.red('Missing dependencies in package.json'));
        process.exit(1);
    }

    const packageVersion = packageJson.dependencies[packageName];
    if (typeof packageVersion === 'undefined') {
        console.error(chalk.red(`Unable to find ${packageName} in package.json`));
        process.exit(1);
    }

    set_caret_range(packageJson.dependencies, 'react');
    set_caret_range(packageJson.dependencies, 'react-dom');

    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + os.EOL);
}

const install = (root, dependencies, verbose) => {
    return new Promise((resolve, reject) => {
        let command = 'npm';
        let args = [
            'install',
            '--no-audit', // https://github.com/facebook/create-react-app/issues/11174
            '--save',
            '--save-exact',
            '--loglevel',
            'error',
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
const execute_script = (root,template) => {
    // console.log('root',root)
    // console.log('template',template)
    return new Promise((resolve, reject) => {
        move_template(root,template)
        resolve()
    });
}
/**
 *
 * @param name
 * @param params
 */
const create_project = async (name, params) => {
    let {verbose, template}=params;
    const root = path.resolve(name);
    const appName = path.basename(root);
    check_project(name,root);
    fs.ensureDirSync(name,{});
    console.log(`Creating a new Application in ${chalk.green(root)}.`);
    const packageJson = {
        name: appName,
        version: '0.1.0',
        private: true,
        devDependencies: {},
        dependencies: {},
        eslintConfig: {
            "extends": []
        }

    };
    const originalDirectory = process.cwd();
    process.chdir(root);
    let templatePackageName = await get_package_from_template(template, originalDirectory);
    if (templatePackageName.endsWith('-ts')){
        packageJson.devDependencies={
            "@types/node": "^22.1.0",
            "nodemon": "^3.1.4",
            "ts-node": "^10.9.2",
            "tslib": "^2.6.3",
            "typescript": "^5.5.4"
        }
        const tsconfigJson = {
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
        fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfigJson, null, 2) + os.EOL);
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2) + os.EOL);
    let templateInfo = await get_package_info(templatePackageName);
    const dependencies = [...(Object.keys(packageJson.dependencies)), templateInfo.name];
    console.log(`Installing dependencies using ${chalk.cyan('npm')}.`)
    for (const dependency of dependencies) {
        if (dependency){
            console.log(`    - ${chalk.cyan(dependency)}`)
        }
    }
    await install(root,dependencies,verbose);
    await execute_script(root,templateInfo.name);
    await install(root,[],verbose);
    const appPackage = require(path.join(root, 'package.json'));
    console.log(chalk.bgGreen(`😁 Success! `));
    console.log(`Created ${appName} at ${chalk.cyan(root)}`);
    console.log('Inside that directory, you can run several commands:');
    for (const scriptsKey in appPackage.scripts) {
        console.log(`    ${chalk.cyan(scriptsKey)}`);
    }
    console.log('-------------------------------')
    console.log(chalk.cyan(' - cd'), appName);
    console.log(chalk.cyan(` - check the README.md`));
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
    const last = await check_client_version('load-template');
    await check_node_version(info.Binaries.Node.version);
    let message=`
    Project Information
      - ${'name'.padEnd(10,' ')}  ${chalk.green(projectName)}
      - ${'client'.padEnd(10,' ')}  ${chalk.green(last)}(remote) | ${chalk.green(packageJson.version)}(local)
      - ${'os'.padEnd(10,' ')}  ${chalk.green(info.System.OS)}
      - ${'node'.padEnd(10,' ')}  ${chalk.green(info.Binaries.Node.version)}
      - ${'npm'.padEnd(10,' ')}  ${chalk.green(info.Binaries.npm.version)}
    `
    for (const paramsKey in params) {
        message+=`  - ${paramsKey.padEnd(10,' ')}  ${chalk.green(params[paramsKey])}`
    }
    console.log(message)
    //cra-template-liaapi-ts
    let template = params.template ?? 'liaapi-ts';
    // await create_project(projectName, params.verbose, params.template);
    await create_project(projectName, {...params,template});
}

module.exports={
    start
}
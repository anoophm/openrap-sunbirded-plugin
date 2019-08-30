import { Inject } from 'typescript-ioc';
import * as path from 'path';
import * as glob from 'glob';
import * as _ from 'lodash';
import DatabaseSDK from './../sdk/database';
import { logger } from '@project-sunbird/ext-framework-server/logger';
import * as fs from 'fs';
import * as uuid from 'uuid';
import * as fse from 'fs-extra';
import { containerAPI } from 'OpenRAP/dist/api';
import { manifest } from '../manifest';
import { isRegExp } from 'util';
import config from '../config';
import { IDesktopAppMetadata, IAddedUsingType } from '../controllers/content/IContent';
import * as PouchDataBase from 'pouchdb';
PouchDataBase.plugin(require('pouchdb-find'));
// return new PouchDataBase(path.join(dbPath, Util.generateId(pluginId, dbName)));

export default class ContentImport {

    private pluginId: string;
    private contentFilesPath: string;
    private downloadsFolderPath: string;


    private fileSDK;
    public dbSDK;

    private watcher: any;

    initialize(pluginId, contentFilesPath, downloadsFolderPath) {
        this.pluginId = pluginId;
        this.downloadsFolderPath = downloadsFolderPath;
        this.contentFilesPath = contentFilesPath;
        this.dbSDK = new PouchDataBase(path.join(downloadsFolderPath, 'bmmdg_content'));
        console.log('--db--path---', path.join(downloadsFolderPath, 'bmmdg_content'));
        console.log(this.dbSDK);
        this.fileSDK = containerAPI.getFileSDKInstance(manifest.id);
    }



    // unzip ecar 
    // read manifest
    // check if the ecar is content or collection
    // if content
    // unzip internal folder and update/insert content db
    // if collection
    // if it has only one manifest.json
    // prepare hierarchy and insert/update in content db
    // if it has manifest with content folders   
    // prepare hierarchy and insert   
    async startImport(req) {
        console.debug(`ReqId = "${req.headers['X-msgid']}": File extraction is started for the file: ${req.fileName}`)
        // unzip to content_files folder
        console.info(` ReqId = "${req.headers['X-msgid']}": File has to be unzipped`);
        await this.fileSDK.unzip(path.join('ecars', req.fileName), 'content', true)
        console.info(` ReqId = "${req.headers['X-msgid']}": File is unzipped, reading manifest file and adding baseDir to manifest`);
        // read manifest file and add baseDir to manifest as content and folder name relative path
        let manifest = await this.fileSDK.readJSON(path.join(this.contentFilesPath, path.basename(req.fileName, path.extname(req.fileName)), 'manifest.json'));
        let items = _.get(manifest, 'archive.items');
        if (items && _.isArray(items) && items.length > 0) {
            // check if it is collection type or not   
            console.debug(`ReqId = "${req.headers['X-msgid']}": checking if the content is of type collection or not`);
            let parent: any | undefined = _.find(items, (i) => {
                return (i.mimeType === 'application/vnd.ekstep.content-collection' && i.visibility === 'Default')
            });

            if (parent) {
                console.info(` ReqId = "${req.headers['X-msgid']}": Found content is of type collection`);
                // check content compatibility level 
                console.debug(` ReqId = "${req.headers['X-msgid']}": Checking content compatability. Collection compatabilitylevel > content compatabilitylevel`);
                if (_.get(parent, 'compatibilityLevel') && parent.compatibilityLevel > config.get("CONTENT_COMPATIBILITY_LEVEL")) {
                    throw `content compatibility is higher then content level : ${parent.compatibilityLevel} app supports ${config.get("CONTENT_COMPATIBILITY_LEVEL")}`;
                }
                console.info(` ReqId = "${req.headers['X-msgid']}": collection compatability > content compatability level`);
                let itemsClone = _.cloneDeep(items);
                console.debug(`ReqId = "${req.headers['X-msgid']}": Has to create Hierarchy for the Parent collection: ${_.get(parent, 'identifier')}  versionNumber: ${_.get(parent, 'pkgVersion')} and versionKey: ${_.get(parent, 'versionKey')}`);
                let children = this.createHierarchy(itemsClone, parent, req.headers['X-msgid'])
                console.info(` ReqId = "${req.headers['X-msgid']}": Hierarchy is created for the collection ${_.get(parent, 'identifier')}`)
                parent['children'] = children;
                parent.desktopAppMetadata = {
                    "ecarFile": req.fileName,  // relative to ecar folder
                    "addedUsing": "import",
                    "createdOn": Date.now(),
                    "updatedOn": Date.now()
                }
                const contentData = await this.dbSDK.get(parent.identifier).catch(error => {
                    console.error(
                        `Received Error while getting content data from db where error = ${error}`
                    );
                });
                console.info(` ReqID = "${req.headers['X-msgid']}":  Collection: ${_.get(parent, 'identifier')} has to be upserted in database`);
                const dbData = await upsert(this.dbSDK, parent.identifier, parent);
                console.info(` ReqID = "${req.headers['X-msgid']}": Collection is upserted in ContentDB `)
                let resources = _.filter(items, (i) => {
                    return (i.mimeType !== 'application/vnd.ekstep.content-collection')
                });
                console.info(` ReqId = "${req.headers['X-msgid']}": Inserting the resources in collection to ContentDB`)
                //insert the resources to content db
                if (!_.isEmpty(resources)) {
                    await resources.forEach(async (resource) => {
                        console.info(` ReqId = "${req.headers['X-msgid']}": including baseDir for all the resources in collection`)
                        // if (_.indexOf(['application/vnd.ekstep.ecml-archive', 'application/vnd.ekstep.html-archive'], resource.mimeType) >= 0) {
                        resource.baseDir = `content/${resource.identifier}`;
                        // } else {
                        //     resource.baseDir = 'content';
                        // }

                        resource.appIcon = resource.appIcon ? `content/${resource.appIcon}` : resource.appIcon;
                        console.debug(`ReqId = "${req.headers['X-msgid']}": added baseDir for Resources and inserting in ContentDB`)
                        await upsert(this.dbSDK, resource.identifier, resource);
                        console.info(` ReqId = "${req.headers['X-msgid']}": Resources are inserted in ContentDB`)
                    })
                }

                //copy directores to content files folder with manifest
                console.info(` ReqId = "${req.headers['X-msgid']}": coping directories to content files folder with manifest`)
                let parentDirPath = path.join(this.contentFilesPath, path.basename(req.fileName, path.extname(req.fileName)));
                fs.readdir(parentDirPath, async (err, files) => {
                    //handling error
                    if (err) {
                        console.error(`ReqId = "${req.headers['X-msgid']}": Error while reading the directory when importing collection`, err)
                    } else {
                        files.forEach(async (file) => {
                            fs.lstat(path.join(parentDirPath, file), async (err, stats) => {
                                if (err) {
                                    console.error(`ReqId = "${req.headers['X-msgid']}": Error while reading files from collection directory`, err)
                                } else {
                                    if (stats.isDirectory()) {
                                        let manifest = {
                                            "id": "content.archive",
                                            "ver": "1.0",
                                            "ts": new Date().toISOString(),
                                            "params": {
                                                "resmsgid": uuid.v4()
                                            },
                                            "archive": {
                                                "count": 1,
                                                "items": []
                                            }
                                        }

                                        let item = _.find(items, { identifier: file })
                                        if (!_.isEmpty(item)) {
                                            manifest.archive.items.push(item)
                                            console.info(` ReqId = "${req.headers['X-msgid']}": created manifest for the file ${file}`);
                                        }
                                        await fse.ensureFile(path.join(parentDirPath, file, 'manifest.json')).catch(err => {
                                            if (err) {
                                                console.error(`ReqId = "${req.headers['X-msgid']}": Error while creating manifest for file ${file}`, err);
                                            }
                                        })
                                        await fse.outputJson(path.join(parentDirPath, file, 'manifest.json'), manifest).catch(err => {
                                            if (err) {
                                                console.error(`ReqId = "${req.headers['X-msgid']}": Error while updating manifest for file ${file} with manifest ${manifest}`, err);
                                            }
                                        })
                                        await fse.copy(path.join(parentDirPath, file), path.join(this.contentFilesPath, file)).catch(err => {
                                            if (err) {
                                                console.error(`ReqId = "${req.headers['X-msgid']}": Error while copying the folder ${path.join(parentDirPath, file)} to content files from collection`, err);
                                            }
                                        })
                                        let zipFilePath = glob.sync(path.join(this.contentFilesPath, file, '**', '*.zip'), {});
                                        if (zipFilePath.length > 0) {
                                            // unzip the file if we have zip file
                                            console.info(` ReqId = "${req.headers['X-msgid']}":  Unzipping the file:${file} if the file is zip file`)
                                            let filePath = path.relative(this.fileSDK.getAbsPath(''), zipFilePath[0]);
                                            await this.fileSDK.unzip(filePath, path.join("content", file), false)
                                            console.info(` ReqId = "${req.headers['X-msgid']}":   file is unzipped`)
                                        }
                                    }
                                }
                            })
                        });
                    }
                })
                if (contentData !== undefined && _.get(contentData, 'desktopAppMetadata.ecarFile') && _.get(dbData, 'id')) {
                    const fileName = path.basename(contentData.desktopAppMetadata.ecarFile, '.ecar');
                    this.deleteContentFolder(path.join('ecars', contentData.desktopAppMetadata.ecarFile));
                    this.deleteContentFolder(path.join('content', fileName));
                }
                return parent;
            } else {

                console.info(` ReqId = "${req.headers['X-msgid']}": Found Content is not of type Collection`);
                // check content compatibility level 
                let metaData = items[0];
                console.info(` ReqId = "${req.headers['X-msgid']}": check (resource) content compatability > content compatability level`);
                if (_.get(metaData, 'compatibilityLevel') && metaData.compatibilityLevel > config.get("CONTENT_COMPATIBILITY_LEVEL")) {
                    throw `content compatibility is higher then content level : ${metaData.compatibilityLevel} app supports ${config.get("CONTENT_COMPATIBILITY_LEVEL")}`;
                }
                console.info(` ReqId = "${req.headers['X-msgid']}": (resource) content compatability > content compatability level`);
                //try to get zip file inside the unzip folder from above step
                let assetFolderGlobPath = path.join(this.contentFilesPath, path.basename(req.fileName, path.extname(req.fileName)), '**', '*.zip')

                let zipFilePath = glob.sync(assetFolderGlobPath, {});
                if (zipFilePath.length > 0) {
                    let filePath = path.relative(this.fileSDK.getAbsPath(''), zipFilePath[0]);
                    // unzip the file if we have zip file
                    console.info(` ReqId = "${req.headers['X-msgid']}": Unzipping the file if there are any zip files`)
                    await this.fileSDK.unzip(filePath, path.join("content", path.basename(req.fileName, path.extname(req.fileName))), false)
                    console.info(` ReqId = "${req.headers['X-msgid']}": Unzipped the zip file `)
                }

                metaData.baseDir = `content/${path.basename(req.fileName, path.extname(req.fileName))}`;
                metaData.appIcon = metaData.appIcon ? `content/${path.basename(req.fileName, path.extname(req.fileName))}/${metaData.appIcon}` : metaData.appIcon;
                const desktopAppMetadata: IDesktopAppMetadata = {
                    "ecarFile": req.fileName,  // relative to ecar folder
                    "addedUsing": IAddedUsingType.import,
                    "createdOn": Date.now(),
                    "updatedOn": Date.now()
                }
                console.info(` ReqId = "${req.headers['X-msgid']}": Metadata and basedir is added for the (resource) content`);
                metaData.desktopAppMetadata = desktopAppMetadata;
                //insert metadata to content database
                // TODO: before insertion check if the first object is type of collection then prepare the collection and insert
                const contentData = await this.dbSDK.get('content', metaData.identifier).catch(error => {
                    console.error(
                        `Received Error while getting content data from db where error = ${error}`
                    );
                });
                console.debug(`ReqID = "${req.headers['X-msgid']}": (Resource) Content is upserting in ContentDB`)
                const dbData = await upsert(this.dbSDK, metaData.identifier, metaData);
                if (contentData !== undefined && _.get(contentData, 'desktopAppMetadata.ecarFile') && _.get(dbData, 'id')) {
                    const fileName = path.basename(contentData.desktopAppMetadata.ecarFile, '.ecar');
                    this.deleteContentFolder(path.join('ecars', contentData.desktopAppMetadata.ecarFile));
                    this.deleteContentFolder(path.join('content', fileName));
                }
                return metaData;
            }

        } else {
            console.error(`ReqId = "${req.headers['X-msgid']}": Ecar is having empty items `, manifest);
            throw Error(`ReqId = "${req.headers['X-msgid']}": Manifest doesn't have items to insert in database`)
        }
    }

    async deleteContentFolder(filepath) {
        await this.fileSDK.remove(filepath).catch(error => {
            console.error(
                `Received Error while deleting the duplicate folder after import is successful for path= ${filepath} and error= ${error}`
            );
        });
    }

    createHierarchy(items: any[], parent: any, reqID?: any, tree?: any[]): any {
        console.debug(`ReqId = "${reqID}": creating Hierarchy for the Collection`);
        console.info(` ReqId = "${reqID}": Getting child contents for Parent: ${_.get(parent, 'identifier')}`);
        tree = typeof tree !== 'undefined' ? tree : [];
        parent = typeof parent !== 'undefined' ? parent : { visibility: 'Default' };
        if (parent.children && parent.children.length) {
            let children = [];
            _.forEach(items, (child) => {
                let childWithIndex = _.find(parent.children, { 'identifier': child.identifier })
                if (!_.isEmpty(childWithIndex)) {
                    child.index = childWithIndex['index'];
                    children.push(child)
                }
            });
            if (!_.isEmpty(children)) {
                children = _.sortBy(children, 'index');
                if (parent.visibility === 'Default') {
                    tree = children;
                } else {
                    parent['children'] = children;
                }
                _.each(children, (child) => { this.createHierarchy(items, child, reqID) });
            }
        }
        console.info(` ReqId = "${reqID}": Child contents are found for Parent: ${_.get(parent, 'identifier')}`);
        return tree;
    }

}

process.on('message', async (req) => {
    console.debug(`ReqId = "${req.headers['X-msgid']}": child process created for file: ${req.fileName}`)
    let contentImport = new ContentImport();
    contentImport.initialize(
        manifest.id,
        req.contentFilesPath,
        req.downloadsFolderPath
    );
    contentImport.startImport(req).then(data => {
        console.debug(`ReqId = "${req.headers['X-msgid']}": child process returning succuss`)
        process.send({ data });
    }).catch(error => {
        console.debug(`ReqId = "${req.headers['X-msgid']}": child process returning error`)
        process.send({ error });
    });
});

async function upsert(database: any, docId: string, doc: any) {
    console.debug(`Upserting document with docId:${docId} in database: "${_.upperCase(database)}" `)
    let docNotFound = false;
    let docResponse = await database.get(docId).catch(err => {
        console.error(`Received error while getting doc from DB: ${_.upperCase(database)} and Error:${err}`);
        if (err.status === 404) {
            docNotFound = true;
        } else {
            // if error is not doc not found then throwing error 
            throw Error(err)
        }
    });
    let result;
    if (docNotFound) {
        console.info(` Doc: ${docId}  NOT found in DB:${_.upperCase(database)}`)
        doc._id = docId;
        result = await database.put(doc);
    } else {
        result = await database.put({ ...docResponse, ...doc });
    }

    return result;
}
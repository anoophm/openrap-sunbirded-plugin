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
import { fork } from 'child_process';
const unZipper = require('unzip-stream');
const stream = require('stream');

let unzipChildProcess;


export default class ContentManager {

    private pluginId: string;
    private contentFilesPath: string;
    private downloadsFolderPath: string;


    private fileSDK;

    @Inject dbSDK: DatabaseSDK;

    private watcher: any;

    initialize(pluginId, contentFilesPath, downloadsFolderPath) {
        this.pluginId = pluginId;
        this.downloadsFolderPath = downloadsFolderPath;
        this.contentFilesPath = contentFilesPath;
        this.dbSDK.initialize(pluginId);
        this.fileSDK = containerAPI.getFileSDKInstance(manifest.id);
    }

    // this method works for only one task at a time. Multiple unzip request at a time will fail
    async unzip(req, filePath: string, destPath: string, extractToFolder: boolean){
        if(!unzipChildProcess){
            unzipChildProcess = fork(path.join(__dirname, '..', 'utils', 'unzip.js'));
        }
        return new Promise((resolve, reject) => {
            unzipChildProcess.send({ message: 'UNZIP', filePath, destPath, extractToFolder, pluginId: manifest.id});
            unzipChildProcess.on('message' , ({error, data}) => {
                if(error){
                    logger.error(`ReqId = "${req.headers['X-msgid']}": File extraction failed for file: ${filePath}`)
                    return reject(error);
                } else if(filePath === data.filePath){
                    logger.info(`ReqId = "${req.headers['X-msgid']}": File extraction successful for file: ${filePath}`)
                    return resolve();
                }
            });
        })
    }
    async createDirectory(path) {
        if (!fs.existsSync(path)){
            fs.mkdirSync(path);
        }
    }
    async writeStream(zipStream, fileName){
        return new Promise( async (resolve, reject) => {
            logger.info(`unzipped content with file type = ${zipStream.type}`);
            logger.info(`and file path = ${zipStream.path}`);
            if (zipStream.type === 'Directory') {
                await this.createDirectory(fileName + '/'+ zipStream.path)
                resolve();
            } else {
                zipStream.pipe(fs.createWriteStream(fileName + '/'+ zipStream.path)).on('finish',resolve);
            }
        })
    }
    async unZipContent(req, res, streamHandler){
        let contentImported: any = false;
        await this.createDirectory(req.filePath)
        streamHandler.pipe(unZipper.Parse())
        .pipe(stream.Transform({
            objectMode: true,
            transform: async (zipStream, e, cb) => {
                if(contentImported){
                    // logger.info(`ReqId = "${req.headers['X-msgid']}": import skipped as content already imported`);
                    req.contentImported = contentImported;
                    zipStream.autodrain();
                    return cb();
                    // return res.send({ success: true });
                }
                await this.writeStream(zipStream, req.filePath);
                if (zipStream.path === "manifest.json") {
                    contentImported = await this.checkContentState(req, res)
                }
                cb()
            }
        }))
    }
    async checkContentState(req, res): Promise<any> {
        return new Promise(async (resolve, reject) => {
            let manifest = await this.fileSDK.readJSON(path.join(this.contentFilesPath, path.basename(req.fileName, path.extname(req.fileName)), 'manifest.json'));
            // console.log(JSON.stringify(manifest, null, 2));
            // logger.info(`manifest details obtained while unzipping = ${manifest}`);
            let items = _.get(manifest, 'archive.items');
            let parent: any | undefined = _.find(items, (i) => {
                return (i.mimeType === 'application/vnd.ekstep.content-collection' && i.visibility === 'Default')
            });
            logger.info(`parent id obtained while unzipping = ${parent.identifier}`);
            const contentData = await this.dbSDK.get('content', parent.identifier).catch(error => {
                logger.error(`checking content in db while streaming failed  = ${error}`);
            });
            logger.info(`content data in db while unzipping = ${contentData}`);
            if(contentData){
                resolve(true);
            } else {
                resolve(false);
            }
        })
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
        logger.debug(`ReqId = "${req.headers['X-msgid']}": File extraction is started for the file: ${req.fileName}`)
        // read manifest file and add baseDir to manifest as content and folder name relative path
        let manifest = await this.fileSDK.readJSON(path.join(this.contentFilesPath, path.basename(req.fileName, path.extname(req.fileName)), 'manifest.json'));
        let items = _.get(manifest, 'archive.items');
        if (items && _.isArray(items) &&
            items.length > 0) {
            // check if it is collection type or not   
            logger.debug(`ReqId = "${req.headers['X-msgid']}": checking if the content is of type collection or not`);
            let parent: any | undefined = _.find(items, (i) => {
                return (i.mimeType === 'application/vnd.ekstep.content-collection' && i.visibility === 'Default')
            });

            if (parent) {
                logger.info(` ReqId = "${req.headers['X-msgid']}": Found content is of type collection`);
                // check content compatibility level 
                logger.debug(` ReqId = "${req.headers['X-msgid']}": Checking content compatability. Collection compatabilitylevel > content compatabilitylevel`);
                if (_.get(parent, 'compatibilityLevel') && parent.compatibilityLevel > config.get("CONTENT_COMPATIBILITY_LEVEL")) {
                    throw `content compatibility is higher then content level : ${parent.compatibilityLevel} app supports ${config.get("CONTENT_COMPATIBILITY_LEVEL")}`;
                }
                logger.info(` ReqId = "${req.headers['X-msgid']}": collection compatability > content compatability level`);
                let itemsClone = _.cloneDeep(items);
                logger.debug(`ReqId = "${req.headers['X-msgid']}": Has to create Hierarchy for the Parent collection: ${_.get(parent, 'identifier')}  versionNumber: ${_.get(parent, 'pkgVersion')} and versionKey: ${_.get(parent, 'versionKey')}`);
                let children = this.createHierarchy(itemsClone, parent, req.headers['X-msgid'])
                logger.info(` ReqId = "${req.headers['X-msgid']}": Hierarchy is created for the collection ${_.get(parent, 'identifier')}`)
                parent['children'] = children;
                parent.desktopAppMetadata = {
                    "ecarFile": req.fileName,  // relative to ecar folder
                    "addedUsing": "import",
                    "createdOn": Date.now(),
                    "updatedOn": Date.now()
                }
                const contentData = await this.dbSDK.get('content', parent.identifier).catch(error => {
                    logger.error(
                        `Received Error while getting content data from db where error = ${error}`
                    );
                });
                logger.info(` ReqID = "${req.headers['X-msgid']}":  Collection: ${_.get(parent, 'identifier')} has to be upserted in database`);
                const dbData = await this.dbSDK.upsert('content', parent.identifier, parent);
                logger.info(` ReqID = "${req.headers['X-msgid']}": Collection is upserted in ContentDB `)
                let resources = _.filter(items, (i) => {
                    return (i.mimeType !== 'application/vnd.ekstep.content-collection')
                });
                logger.info(` ReqId = "${req.headers['X-msgid']}": Inserting the resources in collection to ContentDB`)
                //insert the resources to content db
                if (!_.isEmpty(resources)) {
                    await resources.forEach(async (resource) => {
                        logger.info(` ReqId = "${req.headers['X-msgid']}": including baseDir for all the resources in collection`)
                        // if (_.indexOf(['application/vnd.ekstep.ecml-archive', 'application/vnd.ekstep.html-archive'], resource.mimeType) >= 0) {
                        resource.baseDir = `content/${resource.identifier}`;
                        // } else {
                        //     resource.baseDir = 'content';
                        // }

                        resource.appIcon = resource.appIcon ? `content/${resource.appIcon}` : resource.appIcon;
                        logger.debug(`ReqId = "${req.headers['X-msgid']}": added baseDir for Resources and inserting in ContentDB`)
                        await this.dbSDK.upsert('content', resource.identifier, resource);
                        logger.info(` ReqId = "${req.headers['X-msgid']}": Resources are inserted in ContentDB`)
                    })
                }

                //copy directores to content files folder with manifest
                logger.info(` ReqId = "${req.headers['X-msgid']}": coping directories to content files folder with manifest`)
                let parentDirPath = path.join(this.contentFilesPath, path.basename(req.fileName, path.extname(req.fileName)));
                fs.readdir(parentDirPath, async (err, files) => {
                    //handling error
                    if (err) {
                        logger.error(`ReqId = "${req.headers['X-msgid']}": Error while reading the directory when importing collection`, err)
                    } else {
                        files.forEach(async (file) => {
                            fs.lstat(path.join(parentDirPath, file), async (err, stats) => {
                                if (err) {
                                    logger.error(`ReqId = "${req.headers['X-msgid']}": Error while reading files from collection directory`, err)
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
                                            logger.info(` ReqId = "${req.headers['X-msgid']}": created manifest for the file ${file}`);
                                        }
                                        await fse.ensureFile(path.join(parentDirPath, file, 'manifest.json')).catch(err => {
                                            if (err) {
                                                logger.error(`ReqId = "${req.headers['X-msgid']}": Error while creating manifest for file ${file}`, err);
                                            }
                                        })
                                        await fse.outputJson(path.join(parentDirPath, file, 'manifest.json'), manifest).catch(err => {
                                            if (err) {
                                                logger.error(`ReqId = "${req.headers['X-msgid']}": Error while updating manifest for file ${file} with manifest ${manifest}`, err);
                                            }
                                        })
                                        await fse.copy(path.join(parentDirPath, file), path.join(this.contentFilesPath, file)).catch(err => {
                                            if (err) {
                                                logger.error(`ReqId = "${req.headers['X-msgid']}": Error while copying the folder ${path.join(parentDirPath, file)} to content files from collection`, err);
                                            }
                                        })
                                        let zipFilePath = glob.sync(path.join(this.contentFilesPath, file, '**', '*.zip'), {});
                                        if (zipFilePath.length > 0) {
                                            // unzip the file if we have zip file
                                            logger.info(` ReqId = "${req.headers['X-msgid']}":  Unzipping the file:${file} if the file is zip file`)
                                            let filePath = path.relative(this.fileSDK.getAbsPath(''), zipFilePath[0]);
                                            // await this.fileSDK.unzip(filePath, path.join("content", file), false)
                                            await this.unzip(req, filePath, path.join("content", file), false)
                                            logger.info(` ReqId = "${req.headers['X-msgid']}":   file is unzipped`)
                                        }
                                    }
                                }
                            })
                        });
                    }
                })
                if (contentData !== undefined && _.get(contentData, 'desktopAppMetadata.ecarFile') && _.get(dbData, 'id')) {
                    const fileName = path.basename(contentData.desktopAppMetadata.ecarFile, '.ecar');
                    await this.deleteContentFolder(path.join('ecars', contentData.desktopAppMetadata.ecarFile));
                    await this.deleteContentFolder(path.join('content', fileName));
                }
                return parent;
            } else {

                logger.info(` ReqId = "${req.headers['X-msgid']}": Found Content is not of type Collection`);
                // check content compatibility level 
                let metaData = items[0];
                logger.info(` ReqId = "${req.headers['X-msgid']}": check (resource) content compatability > content compatability level`);
                if (_.get(metaData, 'compatibilityLevel') && metaData.compatibilityLevel > config.get("CONTENT_COMPATIBILITY_LEVEL")) {
                    throw `content compatibility is higher then content level : ${metaData.compatibilityLevel} app supports ${config.get("CONTENT_COMPATIBILITY_LEVEL")}`;
                }
                logger.info(` ReqId = "${req.headers['X-msgid']}": (resource) content compatability > content compatability level`);
                //try to get zip file inside the unzip folder from above step
                let assetFolderGlobPath = path.join(this.contentFilesPath, path.basename(req.fileName, path.extname(req.fileName)), '**', '*.zip')

                let zipFilePath = glob.sync(assetFolderGlobPath, {});
                if (zipFilePath.length > 0) {
                    let filePath = path.relative(this.fileSDK.getAbsPath(''), zipFilePath[0]);
                    // unzip the file if we have zip file
                    logger.info(` ReqId = "${req.headers['X-msgid']}": Unzipping the file if there are any zip files`)
                    // await this.fileSDK.unzip(filePath, path.join("content", path.basename(req.fileName, path.extname(req.fileName))), false)
                    await this.unzip(req, filePath, path.join("content", path.basename(req.fileName, path.extname(req.fileName))), false)
                    logger.info(` ReqId = "${req.headers['X-msgid']}": Unzipped the zip file `)
                }

                metaData.baseDir = `content/${path.basename(req.fileName, path.extname(req.fileName))}`;
                metaData.appIcon = metaData.appIcon ? `content/${path.basename(req.fileName, path.extname(req.fileName))}/${metaData.appIcon}` : metaData.appIcon;
                const desktopAppMetadata: IDesktopAppMetadata = {
                    "ecarFile": req.fileName,  // relative to ecar folder
                    "addedUsing": IAddedUsingType.import,
                    "createdOn": Date.now(),
                    "updatedOn": Date.now()
                }
                logger.info(` ReqId = "${req.headers['X-msgid']}": Metadata and basedir is added for the (resource) content`);
                metaData.desktopAppMetadata = desktopAppMetadata;
                //insert metadata to content database
                // TODO: before insertion check if the first object is type of collection then prepare the collection and insert
                const contentData = await this.dbSDK.get('content', metaData.identifier).catch(error => {
                    logger.error(
                        `Received Error while getting content data from db where error = ${error}`
                    );
                });
                logger.debug(`ReqID = "${req.headers['X-msgid']}": (Resource) Content is upserting in ContentDB`)
                const dbData = await this.dbSDK.upsert('content', metaData.identifier, metaData);
                if (contentData !== undefined && _.get(contentData, 'desktopAppMetadata.ecarFile') && _.get(dbData, 'id')) {
                    const fileName = path.basename(contentData.desktopAppMetadata.ecarFile, '.ecar');
                    await this.deleteContentFolder(path.join('ecars', contentData.desktopAppMetadata.ecarFile));
                    await this.deleteContentFolder(path.join('content', fileName));
                }
                return metaData;
            }

        } else {
            logger.error(`ReqId = "${req.headers['X-msgid']}": Ecar is having empty items `, manifest);
            throw Error(`ReqId = "${req.headers['X-msgid']}": Manifest doesn't have items to insert in database`)
        }
    }

    async deleteContentFolder(filepath) {
        await this.fileSDK.remove(filepath).catch(error => {
            logger.error(
                `Received Error while deleting the duplicate folder after import is successful for path= ${filepath} and error= ${error}`
            );
        });
    } 

    createHierarchy(items: any[], parent: any, reqID?: any,tree?: any[]): any {
        logger.debug(`ReqId = "${reqID}": creating Hierarchy for the Collection`);
        logger.info(` ReqId = "${reqID}": Getting child contents for Parent: ${_.get(parent, 'identifier')}`);
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
        logger.info(` ReqId = "${reqID}": Child contents are found for Parent: ${_.get(parent, 'identifier')}`);
        return tree;
    }

}
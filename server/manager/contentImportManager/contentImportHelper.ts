import { ErrorObj, getErrorObj, handelError, IContentImport, ImportProgress, ImportSteps } from "./IContentImport"
import * as  StreamZip from "node-stream-zip";
import * as  fs from "fs";
import * as  _ from "lodash";
import * as path from "path";
import { manifest } from "../../manifest";
import { containerAPI } from "OpenRAP/dist/api";
import config from "../../config";
import { Subject } from "rxjs";
import { debounceTime, throttleTime } from "rxjs/operators";
const collectionMimeType = "application/vnd.ekstep.content-collection";
let zipHandler, zipEntries, dbContents, manifestJson, contentImportData: IContentImport;
const fileSDK = containerAPI.getFileSDKInstance(manifest.id);
const contentFolder = fileSDK.getAbsPath("content");
const ecarFolder = fileSDK.getAbsPath("ecars");

const syncCloser = (initialProgress, percentage, totalSize = contentImportData.contentSize) => {
  initialProgress = initialProgress ? initialProgress : contentImportData.progress;
  let completed = 1;
  const syncData$ = new Subject<number>();
  const subscription = syncData$.pipe(debounceTime(2500)).subscribe((data) => {
    const newProgress = ((completed / totalSize) * percentage);
    contentImportData.progress = initialProgress + newProgress;
    sendMessage("DATA_SYNC");
  });
  return (chunk = 0) => {
    completed += chunk;
    syncData$.next(completed);
    return subscription;
  };
};

const copyEcar = async () => {
  try {
    process.send({ message: "LOG", logType: "info", logBody: [contentImportData._id, "copping ecar from src location to ecar folder", contentImportData.ecarSourcePath, ecarFolder] });
    const syncFunc = syncCloser(ImportProgress.COPY_ECAR, 25);
    const toStream = fs.createWriteStream(path.join(ecarFolder, contentImportData._id + ".ecar"));
    const fromStream = fs.createReadStream(contentImportData.ecarSourcePath);
    fromStream.pipe(toStream);
    fromStream.on("data", (buffer) => syncFunc(buffer.length));
    toStream.on("finish", (data) => {
      syncFunc().unsubscribe();
      contentImportData.progress = ImportProgress.PARSE_ECAR;
      sendMessage(ImportSteps.copyEcar);
    });
    toStream.on("error", (err) => {
      syncFunc().unsubscribe();
      sendMessage("IMPORT_ERROR", getErrorObj(err, "UNHANDLED_COPY_ECAR_ERROR"));
    });
    fromStream.on("error", (err) => {
      syncFunc().unsubscribe();
      sendMessage("IMPORT_ERROR", getErrorObj(err, "UNHANDLED_COPY_ECAR_ERROR"));
    });
  } catch (err) {
    sendMessage("IMPORT_ERROR", getErrorObj(err, "UNHANDLED_COPY_ECAR_ERROR"));
  }
};

const parseEcar = async () => {
  try {
    const ecarBasePath = path.join(ecarFolder, contentImportData._id + ".ecar");
    const contentBasePath = path.join(contentFolder, contentImportData._id); // temp path
    zipHandler = await loadZipHandler(ecarBasePath).catch(handelError("LOAD_ECAR"));
    await fileSDK.mkdir(path.join("content", contentImportData._id));
    zipEntries = zipHandler.entries();
    const manifestEntry = zipEntries["manifest.json"] || zipEntries["/manifest.json"];
    if (!manifestEntry) {
      throw getErrorObj({ message: "manifest.json is missing in ecar" }, "MANIFEST_MISSING");
    }
    await new Promise((res, rej) =>
      zipHandler.extract(manifestEntry.name, contentBasePath, (err) => err ? rej(err) : res()));
    manifestJson = await fileSDK.readJSON(path.join(contentBasePath, "manifest.json"));
    const parent = _.get(manifestJson, "archive.items[0]");
    if (_.get(parent, "visibility") !== "Default") {
      throw getErrorObj({ message: `manifest.json dosn"t contain content with visibility Default` },
        "INVALID_MANIFEST");
    }
    if (parent.compatibilityLevel > config.get("CONTENT_COMPATIBILITY_LEVEL")) {
      throw getErrorObj({ message: `${parent.compatibilityLevel} not supported. Required ${config.get("CONTENT_COMPATIBILITY_LEVEL")} and below` }, "UNSUPPORTED_COMPATIBILITY_LEVEL");
    }
    contentImportData.contentId = parent.identifier;
    contentImportData.mimeType = parent.mimeType;
    contentImportData.contentType = parent.contentType;
    contentImportData.pkgVersion = _.toString(parent.pkgVersion) || "1.0";
    if (contentImportData.mimeType === "application/vnd.ekstep.content-collection") {
      contentImportData.childNodes = _.filter(_.get(manifestJson, "archive.items"),
        (item) => (item.mimeType !== "application/vnd.ekstep.content-collection"))
        .map((item) => item.identifier);
    }
    contentImportData.progress = ImportProgress.EXTRACT_ECAR;
    sendMessage(ImportSteps.parseEcar);
  } catch (err) {
    sendMessage("IMPORT_ERROR", getErrorObj(err, "UNHANDLED_PARSE_ECAR_ERROR"));
  }
};

const extractZipEntry = async (identifier: string, contentBasePath: string[], entry: string, syncFunc: Function)
  : Promise<boolean | any> => {
  const zipEntry = (identifier === contentImportData.contentId) ? entry : identifier + "/" + entry;
  const entryObj = zipEntries[zipEntry] || zipEntries["/" + zipEntry] ||
  (!_.includes(["manifest.json", "hierarchy.json"], entry) && zipEntries["/" + entry]); // last checks to support mobile
  if (!entryObj) {
    return false;
  }
  if (!contentImportData.extractedEcarEntries[entryObj.name]) {
    await new Promise(async (resolve, reject) => zipHandler.extract(entryObj.name,
      path.join(contentFolder, ...contentBasePath), (err) => err ? reject(err) : resolve()));
    contentImportData.extractedEcarEntries[entryObj.name] = true;
  }
  syncFunc(entryObj.compressedSize);
  return entryObj;
};

const extractEcar = async () => {
  try {
    contentImportData.contentSkipped = [];
    contentImportData.contentAdded = [];
    zipHandler = zipHandler ||
      await loadZipHandler(path.join(ecarFolder, contentImportData._id + ".ecar")).catch(handelError("LOAD_ECAR"));
    manifestJson = manifestJson || await fileSDK.readJSON(path.join(contentFolder, contentImportData._id, "manifest.json"));
    zipEntries = zipHandler.entries();
    const syncFunc = syncCloser(ImportProgress.EXTRACT_ECAR, 65);
    const artifactToBeUnzipped = [];
    let artifactToBeUnzippedSize = 0;
    const extractContent = async (content, parent, collection) => {
      if (collection && !parent && !content.appIcon) { // exit if content is not leaf node or parent
        return;
      }
      const contentBasePath = (collection && !parent) ?
        [contentImportData.contentId, content.identifier] : [content.identifier];
      await fileSDK.mkdir(path.join("content", path.join(...contentBasePath)));
      await extractZipEntry(content.identifier, contentBasePath, content.appIcon, syncFunc);
      await extractZipEntry(content.identifier, contentBasePath, "manifest.json", syncFunc);
      if (collection) {
        if (parent) { // extract hierarchy file for parent if its a collection
          await extractZipEntry(content.identifier, contentBasePath, "hierarchy.json", syncFunc);
        }
        return; // exit if content is collection
      }
      if (content.artifactUrl && content.contentDisposition === "online") { // exit if online only content
        contentImportData.contentAdded.push(content.identifier);
        return;
      }
      const artifactExtracted = await extractZipEntry(content.identifier, contentBasePath,
        content.artifactUrl, syncFunc);
      if (!artifactExtracted) { // exit if artifact is missing
        contentImportData.contentSkipped.push({ id: content.identifier, reason: "ARTIFACT_MISSING" });
        return;
      }
      contentImportData.contentAdded.push(content.identifier);
      if (artifactExtracted.name.endsWith(".zip")) { // append zip entry along with size to unzip later
        artifactToBeUnzippedSize += artifactExtracted.compressedSize;
        artifactToBeUnzipped.push({
          src: path.join("content", ...contentBasePath, path.basename(artifactExtracted.name)),
          size: artifactExtracted.compressedSize,
        });
      }
    };
    for (const content of _.get(manifestJson, "archive.items")) { // loop items in manifest and extract its contents
      const dbContent: any = _.find(dbContents, { identifier: content.identifier });
      if (!dbContent || content.pkgVersion > dbContent.pkgVersion ||
        !_.get(dbContent, "desktopAppMetadata.isAvailable")) { // if content not imported or new ver available
        await extractContent(content, (content.identifier === contentImportData.contentId),
          (content.mimeType === collectionMimeType));
      } else {
        contentImportData.contentSkipped.push({ id: content.identifier, reason: "CONTENT_IMPORTED_ALREADY" });
      }
    }
    syncFunc().unsubscribe();
    process.send({ message: "LOG", logType: "info", logBody: [contentImportData._id, "ecar extracted"] });
    await unzipArtifacts(artifactToBeUnzipped, artifactToBeUnzippedSize)
      .catch(handelError("EXTRACT_ARTIFACTS")); // extract all zip artifacts
    process.send({ message: "LOG", logType: "info", logBody: [contentImportData._id, "artifacts unzipped"] });
    await removeFile(path.join("ecars", contentImportData._id + ".ecar")); // delete ecar folder
    await removeFile(path.join("content", contentImportData._id)); // delete temp content folder which has manifest.json
    sendMessage(ImportSteps.extractEcar);
  } catch (err) {
    sendMessage("IMPORT_ERROR", getErrorObj(err, "UNHANDLED_EXTRACT_ECAR_ERROR"));
  } finally {
    if (zipHandler.close) {
      zipHandler.close();
    }
  }
};

const removeFile = (location) => {
  return fileSDK.remove(location)
    .catch((err) => process.send({ message: "LOG", logType: "error", logBody: [contentImportData._id, "error while deleting ecar folder", location] }));
};

const unzipFile = async (src, dest = path.dirname(src)) => {
  await fileSDK.unzip(src, dest, false)
    .catch((err) => process.send({ message: "LOG", logType: "error", logBody: [contentImportData._id, "error while unzip file", src] }));
};

const unzipArtifacts = async (artifactToBeUnzipped = [], artifactToBeUnzippedSize) => {
  const syncFunc = syncCloser(ImportProgress.EXTRACT_ARTIFACT, 9, artifactToBeUnzippedSize);
  for (const artifact of artifactToBeUnzipped) {
    syncFunc(artifact.size);
    if (!contentImportData.artifactUnzipped[artifact.src]) {
      await unzipFile(artifact.src);
      await removeFile(artifact.src);
      contentImportData.artifactUnzipped[artifact.src] = true;
    }
  }
  syncFunc().unsubscribe();
};

const loadZipHandler = async (filePath) => {
  const zip = new StreamZip({ file: filePath, storeEntries: true, skipEntryNameValidation: true });
  return new Promise((resolve, reject) => {
    zip.on("ready", () => resolve(zip));
    zip.on("error", reject);
  });
};

const sendMessage = (message: string, err?: ErrorObj) => {
  const messageObj: any = {
    message, contentImportData,
  };
  if (err) {
    messageObj.err = err;
  }
  process.send(messageObj);
};

process.on("message", (data) => {
  if (_.includes([ImportSteps.copyEcar, ImportSteps.parseEcar, ImportSteps.extractEcar], data.message)) {
    contentImportData = data.contentImportData;
  }
  if (data.message === ImportSteps.copyEcar) {
    copyEcar();
  } else if (data.message === ImportSteps.parseEcar) {
    parseEcar();
  } else if (data.message === ImportSteps.extractEcar) {
    dbContents = data.dbContents;
    extractEcar();
  } else if (data.message === "KILL") {
    sendMessage("DATA_SYNC_KILL");
  }
});

import * as _ from "lodash";
import { containerAPI } from "OpenRAP/dist/api";
const telemetryInstance = containerAPI.getTelemetrySDKInstance().getInstance();

export default class TelemetryHelper {

    public logShareEvent(shareItems: object[], dir: string, telemetryEnv: string) {
        const telemetryEvent: any = {
            context: {
                env: telemetryEnv,
            },
            edata: {
                dir,
                type: "File",
                items: shareItems,
            },
        };
        telemetryInstance.share(telemetryEvent);
    }

    public logSearchEvent(edata: {}, telemetryEnv: string) {
        const telemetryEvent: any = {
            context: {
                env: telemetryEnv,
            },
            edata: {
                type: _.get(edata, "type"),
                query: _.get(edata, "query") || "",
                filters: _.get(edata, "filters") || {},
                sort: _.get(edata, "sort") || {},
                correlationid:  _.get(edata, "correlationid") || "",
                size:  _.get(edata, "size"),
                topn:  _.get(edata, "topn") || [{}],
            },
        };
        telemetryInstance.search(telemetryEvent);
    }
}

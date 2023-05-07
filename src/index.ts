import { getNotifications } from "@open-rpc/client-js/build/Request"
import type { JSONRPCRequestData, IJSONRPCData } from "@open-rpc/client-js/build/Request"
import { Transport } from "@open-rpc/client-js/build/transports/Transport"

import * as createClangdModule from "@clangd-wasm/core/dist/clangd"

import packageInfo from "../package.json"

// Adapted from https://github.com/ffmpegwasm/ffmpeg.wasm/blob/master/src/browser/getCreateFFmpegCore.js 
const toBlobURL = async (url: string, mimeType: string) => {
    const buf = await (await fetch(url)).arrayBuffer();
    const blob = new Blob([buf], { type: mimeType });
    const blobURL = URL.createObjectURL(blob);
    return blobURL;
};

type CompileCommandEntry = {
    directory: string,
    file: string,
    arguments: string[],
    output?: string 
};

type CompileCommands = CompileCommandEntry[];

type ClangdStdioTransportOptions = {
    baseURL?: string,
    debug?: boolean,
    compileCommands?: CompileCommands
}

class ClangdModule {
    FS: any
    mainScriptUrlOrBlob: string

    outputMessageBuf: number[] = []
    outputMessageLength: null | number = null
    stderrBuf: number[] = []

    mainJSObjectURL: string;
    workerJSObjectURL: string;

    options: ClangdStdioTransportOptions
    onMessageHook: (data: string) => void
    baseURL: any

    constructor(options: ClangdStdioTransportOptions, onMessageHook: (data: string) => void) {
        this.options = options
        this.onMessageHook = onMessageHook
    }

    preRun(module: ClangdModule) {
        const stdin = function (): number | null {
            return null
        }

        const stdout = function (inByte: number) {
            // We handle things byte by byte instead of character by character
            // to make sure we're unicode friendly
            module.outputMessageBuf.push(inByte)

            let outputMessageString
            try {
                outputMessageString = new TextDecoder().decode(new Uint8Array(module.outputMessageBuf))
            } catch {
                // We're in the middle of receiving a multi-byte character.
                return
            }

            if (module.outputMessageLength == null) {
                // Receiving headers
                if (outputMessageString.endsWith("\r\n\r\n")) {
                    module.outputMessageLength = parseInt(outputMessageString.split(":")[1].trim())
                    module.outputMessageBuf = []
                }
            } else {
                if (module.outputMessageBuf.length == module.outputMessageLength) {
                    // message time!
                    module.onMessageHook(outputMessageString)
                    module.outputMessageBuf = []
                    module.outputMessageLength = null
                }
            }
        }

        const stderr = function (outByte: number) {
            if (!module.options.debug)
                return;

            module.stderrBuf.push(outByte)

            let stderrString
            try {
                stderrString = new TextDecoder().decode(new Uint8Array(module.stderrBuf))
            } catch {
                // We're in the middle of receiving a multi-byte character.
                return
            }

            if (stderrString.endsWith("\n")) { // \n
                console.warn(stderrString)
                module.stderrBuf = []
            }
        }

        module.FS.init(stdin, stdout, stderr)

        // There's no way to load a compile_commands.json config by the command line.
        // We need to write it into the project folder for it to be loaded.
        module.FS.writeFile("/compile_commands.json", JSON.stringify(module.options.compileCommands));
    }

    locateFile(path: string, _prefix: string) {
        if (path.endsWith(".worker.js")) {
            return this.workerJSObjectURL;
        } else if (path.endsWith(".js")) {
            return this.mainJSObjectURL;
        }

        return this.options.baseURL + "/" + path;
    }

    async start() {
        this.mainJSObjectURL = await toBlobURL(`${this.options.baseURL}/clangd.js`, "application/javascript");
        this.workerJSObjectURL = await toBlobURL(`${this.options.baseURL}/clangd.worker.js`, "application/javascript");

        this.mainScriptUrlOrBlob = this.mainJSObjectURL;

        createClangdModule(this)
    }

    messageBuf: object[] = []
}

// Transport structure from https://gitlab.com/aedge/codemirror-web-workers-lsp-demo
class ClangdStdioTransport extends Transport {
    module: ClangdModule
    options: ClangdStdioTransportOptions

    constructor(options?: ClangdStdioTransportOptions) {
        super()

        this.options = options

        if (this.options === undefined) {
            this.options = {}
        }

        if (this.options.baseURL === undefined) {
            this.options.baseURL = `https://unpkg.com/@clangd-wasm/core@${packageInfo.devDependencies['@clangd-wasm/core'].substring(1)}/dist`;
        }

        if (this.options.debug === undefined) {
            this.options.debug = false;
        }

        if (this.options.compileCommands === undefined) {
            this.options.compileCommands = []
        }

        this.module = new ClangdModule(this.options, (data) => {
            if (this.options.debug) {
                console.log("LS to editor <-", JSON.parse(data))
            }

            this.transportRequestManager.resolveResponse(data);
        });
    }

    public connect(): Promise<void> {
        return new Promise(async resolve => {
            await this.module.start();
            resolve()
        })
    }

    public async sendData(data: JSONRPCRequestData): Promise<any> {
        if (this.options.debug) {
            console.log("Editor to LS ->", data)
        }

        const prom = this.transportRequestManager.addRequest(data, null)
        const notifications = getNotifications(data)
        this.module.messageBuf.push((data as IJSONRPCData).request)
        this.transportRequestManager.settlePendingRequest(notifications)
        return prom
    }

    public close(): void { }
}

export { ClangdStdioTransportOptions, CompileCommands, ClangdStdioTransport }
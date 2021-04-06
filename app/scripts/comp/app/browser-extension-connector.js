import kdbxweb from 'kdbxweb';
import { box as tweetnaclBox } from 'tweetnacl';
import { RuntimeInfo } from 'const/runtime-info';
import { Launcher } from 'comp/launcher';
import { AppSettingsModel } from 'models/app-settings-model';

const connectedClients = {};

function incrementNonce(nonce) {
    // from libsodium/utils.c, like it is in KeePassXC
    let i = 0;
    let c = 1;
    for (; i < nonce.length; ++i) {
        c += nonce[i];
        nonce[i] = c;
        c >>= 8;
    }
}

function getClient(request) {
    if (!request.clientID) {
        throw new Error('Empty clientID');
    }
    const client = connectedClients[request.clientID];
    if (!client) {
        throw new Error(`Client not connected: ${request.clientID}`);
    }
    return client;
}

function decryptRequest(request) {
    const client = getClient(request);

    if (!request.nonce) {
        throw new Error('Empty nonce');
    }
    if (!request.message) {
        throw new Error('Empty message');
    }

    const nonce = kdbxweb.ByteUtils.base64ToBytes(request.nonce);
    const message = kdbxweb.ByteUtils.base64ToBytes(request.message);

    const data = tweetnaclBox.open(message, nonce, client.publicKey, client.keys.secretKey);

    const json = new TextDecoder().decode(data);
    const payload = JSON.parse(json);

    if (payload?.action !== request.action) {
        throw new Error(`Bad action in decrypted payload`);
    }

    return payload;
}

function encryptResponse(request, payload) {
    const client = getClient(request);

    const json = JSON.stringify(payload);
    const data = new TextEncoder().encode(json);

    let nonce = kdbxweb.ByteUtils.base64ToBytes(request.nonce);
    incrementNonce(nonce);

    const encrypted = tweetnaclBox(data, nonce, client.publicKey, client.keys.secretKey);

    const message = kdbxweb.ByteUtils.bytesToBase64(encrypted);
    nonce = kdbxweb.ByteUtils.bytesToBase64(nonce);

    return {
        action: request.action,
        message,
        nonce
    };
}

const ProtocolHandlers = {
    'ping'({ data }) {
        return { data };
    },

    'change-public-keys'({ publicKey, clientID: clientId }) {
        const keys = tweetnaclBox.keyPair();
        publicKey = kdbxweb.ByteUtils.base64ToBytes(publicKey);

        connectedClients[clientId] = { publicKey, keys };

        return {
            action: 'change-public-keys',
            version: RuntimeInfo.version,
            publicKey: kdbxweb.ByteUtils.bytesToBase64(keys.publicKey),
            success: 'true'
        };
    },

    'get-databasehash'(request) {
        decryptRequest(request);
        return encryptResponse(request, {
            action: 'hash',
            version: RuntimeInfo.version,
            hash: 'TODO'
        });
    }
};

const BrowserExtensionConnector = {
    init() {
        AppSettingsModel.on('change:browserExtension', (model, enabled) => {
            if (enabled) {
                this.start();
            } else {
                this.stop();
            }
        });
        if (AppSettingsModel.browserExtension) {
            this.start();
        }
    },

    start() {
        if (!Launcher) {
            this.startWebMessageListener();
        }
    },

    stop() {
        if (!Launcher) {
            this.stopWebMessageListener();
        }
    },

    startWebMessageListener() {
        window.addEventListener('message', this.browserWindowMessage);
    },

    stopWebMessageListener() {
        window.removeEventListener('message', this.browserWindowMessage);
    },

    browserWindowMessage(e) {
        if (e.origin !== location.origin) {
            return;
        }
        if (e.source !== window) {
            return;
        }
        if (e?.data?.kwConnect !== 'request') {
            return;
        }
        let response;
        try {
            const handler = ProtocolHandlers[e.data.action];
            if (!handler) {
                throw new Error(`Handler not found: ${e.data.action}`);
            }
            response = handler(e.data) || {};
        } catch (e) {
            response = { error: e.message || 'Unknown error' };
        }
        if (response) {
            response.kwConnect = 'response';
            postMessage(response, window.location.origin);
        }
    }
};

export { BrowserExtensionConnector };
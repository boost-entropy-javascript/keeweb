import { Events } from 'framework/events';
import { Launcher } from 'comp/launcher';
import { Logger } from 'util/logger';
import { UsbListener } from 'comp/app/usb-listener';
import { AppSettingsModel } from 'models/app-settings-model';
import { Timeouts } from 'const/timeouts';
import { YubiKeyProductIds, YubiKeyChallengeSize } from 'const/hardware';
import { Locale } from 'util/locale';

const logger = new Logger('yubikey');

const YubiKey = {
    ykmanStatus: undefined,
    process: null,
    aborted: false,

    get ykChalResp() {
        if (!this._ykChalResp) {
            this._ykChalResp = Launcher.reqNative('yubikey-chalresp');
        }
        return this._ykChalResp;
    },

    checkToolStatus() {
        if (this.ykmanStatus === 'ok') {
            return Promise.resolve(this.ykmanStatus);
        }
        return new Promise((resolve) => {
            this.ykmanStatus = 'checking';
            Launcher.spawn({
                cmd: 'ykman',
                args: ['-v'],
                noStdOutLogging: true,
                complete: (err, stdout, code) => {
                    if (err || code !== 0) {
                        this.ykmanStatus = 'error';
                    } else {
                        this.ykmanStatus = 'ok';
                    }
                    resolve(this.ykmanStatus);
                }
            });
        });
    },

    abort() {
        logger.info('Aborting');
        if (this.process) {
            logger.info('Killing the process');
            try {
                this.process.kill();
            } catch {}
        }
        this.aborted = true;
        this.process = null;
    },

    list(callback) {
        this.ykChalResp.getYubiKeys({}, (err, yubiKeys) => {
            if (err) {
                return callback(err);
            }
            yubiKeys = yubiKeys.map(({ serial, vid, pid, version, slots }) => {
                return {
                    vid,
                    pid,
                    serial,
                    slots,
                    fullName: this.getKeyFullName(pid, version, serial)
                };
            });
            callback(null, yubiKeys);
        });
    },

    getKeyFullName(pid, version, serial) {
        let name = 'YubiKey';
        if (YubiKeyProductIds.Gen1.includes(pid)) {
            name += ' Gen 1';
        } else if (YubiKeyProductIds.NEO.includes(pid)) {
            name += ' NEO';
        } else if (YubiKeyProductIds.YK4.includes(pid)) {
            if (version >= '5.1.0') {
                name += ' 5';
            }
        }
        return `${name} ${serial}`;
    },

    listWithYkman(callback) {
        this._listWithYkman(callback, true);
    },

    _listWithYkman(callback, canRetry) {
        if (this.process) {
            return callback('Already in progress');
        }
        this.aborted = false;

        logger.info('Listing YubiKeys');

        if (UsbListener.attachedYubiKeys.length === 0) {
            return callback(null, []);
        }

        this.process = Launcher.spawn({
            cmd: 'ykman',
            args: ['list'],
            noStdOutLogging: true,
            complete: (err, stdout) => {
                this.process = null;

                if (this.aborted) {
                    return callback('Aborted');
                }
                if (err) {
                    return callback(err);
                }

                const yubiKeysIncludingEmpty = stdout
                    .trim()
                    .split(/\n/g)
                    .map((line) => {
                        const fullName = line;
                        const serial = (line.match(/\d{5,}$/g) || [])[0];
                        return { fullName, serial };
                    });

                const yubiKeys = yubiKeysIncludingEmpty.filter((s) => s.serial);

                if (
                    yubiKeysIncludingEmpty.length === 1 &&
                    yubiKeys.length === 0 &&
                    stdout.startsWith('YubiKey') &&
                    stdout.includes('CCID') &&
                    !stdout.includes('Serial')
                ) {
                    logger.info('The YubiKey is probably stuck');
                    if (!AppSettingsModel.yubiKeyStuckWorkaround) {
                        return callback(Locale.yubiKeyStuckError);
                    }
                    if (canRetry) {
                        return this._repairStuckYubiKey(callback);
                    }
                }

                if (!yubiKeys.length) {
                    return callback('No YubiKeys returned by "ykman list"');
                }

                callback(null, yubiKeys);
            }
        });
    },

    _repairStuckYubiKey(callback) {
        logger.info('Repairing a stuck YubiKey');

        let openTimeout;
        const countYubiKeys = UsbListener.attachedYubiKeys.length;
        const onDevicesChangedDuringRepair = () => {
            if (UsbListener.attachedYubiKeys.length === countYubiKeys) {
                logger.info('YubiKey was reconnected');
                Events.off('usb-devices-changed', onDevicesChangedDuringRepair);
                clearTimeout(openTimeout);
                this.aborted = false;
                setTimeout(() => {
                    this._listWithYkman(callback, false);
                }, Timeouts.ExternalDeviceAfterReconnect);
            }
        };
        Events.on('usb-devices-changed', onDevicesChangedDuringRepair);

        Launcher.spawn({
            cmd: 'ykman',
            args: ['config', 'usb', '-e', 'oath', '-f'],
            noStdOutLogging: true,
            complete: (err) => {
                logger.info('Repair complete', err ? 'with error' : 'OK');
                if (err) {
                    Events.off('usb-devices-changed', onDevicesChangedDuringRepair);
                    return callback(`YubiKey repair error: ${err}`);
                }
                openTimeout = setTimeout(() => {
                    Events.off('usb-devices-changed', onDevicesChangedDuringRepair);
                }, Timeouts.ExternalDeviceReconnect);
            }
        });
    },

    getOtpCodes(serial, callback) {
        if (this.process) {
            return callback('Already in progress');
        }
        this.aborted = false;

        this.process = Launcher.spawn({
            cmd: 'ykman',
            args: ['-d', serial, 'oath', 'code'],
            noStdOutLogging: true,
            throwOnStdErr: true,
            complete: (err, stdout) => {
                this.process = null;

                if (this.aborted) {
                    return callback('Aborted');
                }
                if (err) {
                    return callback(err);
                }

                const codes = [];

                for (const line of stdout.split('\n')) {
                    const match = line.match(/^(.*?):(.*?)\s+(.*)$/);
                    if (!match) {
                        continue;
                    }
                    const [, title, user, code] = match;
                    const needsTouch = !code.match(/^\d+$/);

                    codes.push({
                        title,
                        user,
                        needsTouch
                    });
                }

                callback(null, codes);
            }
        });
    },

    getOtp(serial, entry, callback) {
        return Launcher.spawn({
            cmd: 'ykman',
            args: ['-d', serial, 'oath', 'code', '--single', entry],
            noStdOutLogging: true,
            complete: (err, stdout) => {
                if (err) {
                    return callback(err);
                }
                const otp = stdout.trim();
                callback(null, otp);
            }
        });
    },

    calculateChalResp(chalResp, challenge, callback) {
        const { vid, pid, serial, slot } = chalResp;
        const yubiKey = { vid, pid, serial };

        challenge = Buffer.from(challenge);

        // https://github.com/Yubico/yubikey-personalization-gui/issues/86
        // https://github.com/keepassxreboot/keepassxc/blob/develop/src/keys/drivers/YubiKey.cpp#L318

        const padLen = YubiKeyChallengeSize - challenge.byteLength;

        const paddedChallenge = Buffer.alloc(YubiKeyChallengeSize, padLen);
        challenge.copy(paddedChallenge);

        this.ykChalResp.challengeResponse(yubiKey, paddedChallenge, slot, (err, response) => {
            if (err) {
                if (err.code === this.ykChalResp.YK_ENOKEY) {
                    err.noKey = true;
                }
                if (err.code === this.ykChalResp.YK_ETIMEOUT) {
                    err.timeout = true;
                }
                return callback(err);
            }
            callback(null, response);
        });
    },

    cancelChalResp() {
        this.ykChalResp.cancelChallengeResponse();
    }
};

export { YubiKey };

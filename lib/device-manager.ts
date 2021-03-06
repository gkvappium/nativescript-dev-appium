import {
    waitForOutput,
    resolve,
    log,
    isWin,
    shutdown,
    executeCommand
} from "./utils";
import * as child_process from "child_process";
import { INsCapabilities } from "./interfaces/ns-capabilities";
import { IDeviceManager } from "./interfaces/device-manager";

import {
    IDevice,
    Device,
    DeviceController,
    IOSController,
    AndroidController,
    Platform,
    Status,
    DeviceType
} from "mobile-devices-controller";

export class DeviceManager implements IDeviceManager {
    private static _emulators: Map<string, IDevice> = new Map();

    constructor() {
    }

    public async startDevice(args: INsCapabilities): Promise<IDevice> {
        args.appiumCaps.platformName = args.appiumCaps.platformName.toLowerCase();
        let device: IDevice = DeviceManager.getDefaultDevice(args);
        if (process.env["DEVICE_TOKEN"]) {
            device.token = process.env["DEVICE_TOKEN"];
            device.name = process.env["DEVICE_NAME"] || device.name;
            const allDevices = await DeviceController.getDevices({ platform: device.platform });
            const foundDevice = DeviceController.filter(allDevices, { token: device.token.replace("emulator-", "") })[0];
            console.log("Device: ", foundDevice);
            return foundDevice;
        }

        // When isSauceLab specified we simply do nothing;
        if (args.isSauceLab || args.ignoreDeviceController) {
            args.ignoreDeviceController = true;
            DeviceManager._emulators.set(args.runType, device);
            return device;
        }

        const allDevices = await DeviceController.getDevices({ platform: args.appiumCaps.platformName });
        if (!allDevices || allDevices === null || allDevices.length === 0) {
            console.log("We couldn't find any devices. We will try to proceed to appium! Maybe avd manager is missing")
            console.log("Available devices:\n", allDevices);
        }

        const searchObj = args.appiumCaps.udid ? { token: args.appiumCaps.udid } : { name: args.appiumCaps.deviceName, apiLevel: args.appiumCaps.platformVersion };
        let searchedDevices = DeviceController.filter(allDevices, searchObj);
        if (!searchedDevices || searchedDevices.length === 0) {
            console.log(`No such device ${args.appiumCaps.deviceName}!!!\n Check your device name!!!`);
            console.log("Available devices:\n", allDevices);
        }

        if (searchedDevices && searchedDevices.length > 0) {

            // Should find new device
            if (!args.reuseDevice) {
                device = DeviceController.filter(searchedDevices, { status: Status.SHUTDOWN })[0];
            }

            // If there is no shutdown device
            if (!device || device === null || !device.status) {
                device = DeviceController.filter(searchedDevices, { status: Status.BOOTED })[0];
            }

            // In case reuse device is true but there weren't any booted devices. We need to fall back and boot new one.
            if (!device || device === null && args.reuseDevice) {
                device = DeviceController.filter(searchedDevices, { status: Status.SHUTDOWN })[0];
            }

            if (device.status === Status.SHUTDOWN) {
                await DeviceController.startDevice(device);
                console.log("Started device: ", device);
            } else {
                console.log("Device is already started", device);
                if (!args.reuseDevice && device.type !== DeviceType.EMULATOR && device.type !== DeviceType.SIMULATOR) {
                    console.log("Since is it specified without reusing, the device would be shut down and restart!");
                    DeviceController.kill(device);
                    await DeviceController.startDevice(device);
                }
            }
        }

        DeviceManager._emulators.set(args.runType, device);

        return device;
    }

    public async stopDevice(args: INsCapabilities): Promise<any> {
        if (DeviceManager._emulators.has(args.runType)
            && !args.reuseDevice
            && !args.isSauceLab
            && !args.ignoreDeviceController) {
            const device = DeviceManager._emulators.get(args.runType);
            await DeviceManager.kill(device);
        }
    }

    public async installApp(args: INsCapabilities): Promise<any> {
        if (args.isIOS) {
            IOSController.installApp(args.device, args.appiumCaps.app);
            console.log(`Application is successfully installed!`)
        } else {
            AndroidController.installApp(args.device, args.appiumCaps.app)
        }
    }

    public async uninstallApp(args: INsCapabilities): Promise<any> {
        if (args.isIOS) {
            await IOSController.uninstallApp(args.device, args.appPath, args.appiumCaps["bundleId"]);
        } else {
            await Promise.resolve(AndroidController.uninstallApp(args.device, args.appiumCaps["appPackage"]));
        }
    }

    public static async kill(device: IDevice) {
        await DeviceController.kill(device);
    }

    private static getDefaultDevice(args) {
        let device = new Device(args.appiumCaps.deviceName, args.appiumCaps.platformVersion, undefined, args.appiumCaps.platformName.toLowerCase(), undefined, undefined);
        device.config = { "density": args.appiumCaps.density, "offsetPixels": args.appiumCaps.offsetPixels };
        delete args.appiumCaps.density;
        delete args.appiumCaps.offsetPixels;
        return device;
    }

    public static async setDontKeepActivities(args: INsCapabilities, driver, value) {
        if (args.isAndroid) {
            if (!args.ignoreDeviceController) {
                AndroidController.setDontKeepActivities(value, args.device);
            } else if (args.relaxedSecurity) {
                const status = value ? 1 : 0;
                const output = await DeviceManager.executeShellCommand(driver, { command: "settings", args: ['put', 'global', 'always_finish_activities', status] });
                //check if set 
                const check = await DeviceManager.executeShellCommand(driver, { command: "settings", args: ['get', 'global', 'always_finish_activities'] });
                console.info(`always_finish_activities: ${check}`);
            }
        } else {
            // Do nothing for iOS ...
        }
    }

    public static async executeShellCommand(driver: IDevice, commandAndargs: { command: string, "args": Array<any> }) {
        if (driver.platform.toLowerCase() === Platform.ANDROID) {
            const output = await driver.execute("mobile: shell", commandAndargs);
            return output;
        }
        return undefined;
    }

    public static async getDensity(args: INsCapabilities, driver) {
        args.device.config = args.device.config || {};
        if (args.appiumCaps.platformName.toLowerCase() === "android") {
            if (!args.ignoreDeviceController) {
                args.device.config.density = await AndroidController.getPhysicalDensity(args.device);
            }

            if (args.relaxedSecurity) {
                args.device.config.density = await DeviceManager.executeShellCommand(driver, { command: "wm", args: ["density"] });
                console.log(`Device density recieved from adb shell command ${args.device.config.density}`);
            }

            if (args.device.config.density) {
                args.device.config['offsetPixels'] = AndroidController.calculateScreenOffset(args.device.config.density);
            }
        } else {
            IOSController.getDevicesScreenInfo().forEach((v, k, m) => {
                if (args.device.name.includes(k)) {
                    args.device.config = {
                        density: args.device.config['density'] || v.density,
                        offsetPixels: v.actionBarHeight
                    };
                }
            });
        }
    }

    public static async applyDeviceAdditionsSettings(driver, args: INsCapabilities, sessionIfno: any) {
        if (!args.device.config || !args.device.config.offsetPixels) {
            args.device.config = {};
            let density: number = sessionIfno[1].deviceScreenDensity ? sessionIfno[1].deviceScreenDensity / 100 : undefined;

            if (density) {
                console.log(`Get density from appium session: ${density}`);
                args.device.config['density'] = density;
                args.device.config['offsetPixels'] = AndroidController.calculateScreenOffset(args.device.config.density);
            }

            if (!density) {
                await DeviceManager.getDensity(args, driver);
            }

            density ? console.log(`Device setting:`, args.device.config) : console.log(`Could not resolve device density. Please provide offset in appium config`);
        }
    }

    public getPackageId(device: IDevice, appPath: string): string {
        const appActivity = (device.type === DeviceType.EMULATOR || device.platform === Platform.ANDROID) ? AndroidController.getPackageId(appPath) : IOSController.getIOSPackageId(device.type, appPath);
        return appActivity;
    }
}
/*    Copyright 2021 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const Platform = require('../Platform.js');
const { execSync } = require('child_process');
const exec = require('child-process-promise').exec;
const log = require('../../util/logger.js')(__filename);
const util = require('../../util/util.js');
const sensorLoader = require('../../sensors/sensor_loader.js');
const WIFI_DRV_NAME='8821cu';

class GoldPlatform extends Platform {
  getName() {
    return "gold";
  }

  getLSBCodeName() {
    return execSync("lsb_release -cs", {encoding: 'utf8'}).trim();
  }

  isUbuntu20() {
    return this.getLSBCodeName() === 'focal';
  }

  getDefaultNetworkJsonFile() {
    return `${__dirname}/files/default_setup.json`;
  }

  async getWlanVendor() {
    return WIFI_DRV_NAME;
  }

  getWpaCliBinPath() {
    if (this.isUbuntu20())
      return `${__dirname}/bin/u20/wpa_cli`
    else
      return `${__dirname}/bin/wpa_cli`;
  }

  getWpaPassphraseBinPath() {
    return `${__dirname}/bin/wpa_passphrase`;
  }

  getModelName() {
    return "Firewalla Gold";
  }

  getWifiClientInterface() {
    return "wlan0";
  }

  getWifiAPInterface() {
    return "wlan1";
  }

  async getMacByIface(iface) {
    const mac = await exec(`ip --br link show dev ${iface} | awk '{print $3}'`).then( result => result.stdout.trim()).catch( (err) => {
      log.error(`Failed to get MAC of ${iface}`, err.message);
      return null;
    });
    return mac;
  }

  async resetWLANMac() {
    // reset MAC address of wlan1
    const clientIface = this.getWifiClientInterface();
    const apIface = this.getWifiAPInterface();
    const clientMac = await this.getMacByIface(clientIface);
    log.info(`${clientIface} is ${clientMac}`);
    if (clientMac) {

      const ifplug = sensorLoader.getSensor("IfPlugSensor");
      if(ifplug) {
        await ifplug.stopMonitoringInterface(apIface);
        await ifplug.stopMonitoringInterface(clientIface);
      }

      const apMac =  Number(parseInt(clientMac.replace(/:/g,''),16)+1).toString(16).replace(/(..)(?=.)/g,'$1:');
      log.info(`${apIface} is ${apMac}`);

      // shutdown dependant services
      await exec(`sudo systemctl stop firerouter_wpa_supplicant@${clientIface}`).catch((err) => {})
      await exec(`sudo systemctl stop firerouter_hostapd@${apIface}`).catch((err) => {})

      // a hard code 1-second wait for system to release wifi interfaces
      await util.delay(1000);

      // force shutdown interfaces
      await exec(`sudo ip link set ${clientIface} down`).catch((err) => {
        log.error(`Failed to turn off interface ${clientIface}`, err.message);
      });
      await exec(`sudo ip link set ${apIface} down`).catch((err) => {
        log.error(`Failed to turn off interface ${apIface}`, err.message);
      });

      // set mac address
      log.info(`Set ${apIface} MAC to ${apMac}`);
      await exec(`sudo ip link set ${apIface} address ${apMac}`).catch((err) => {
        log.error(`Failed to set MAC address of ${apIface}`, err.message);
      });

      if(ifplug) {
        await ifplug.startMonitoringInterface(clientIface);
        await ifplug.startMonitoringInterface(apIface);
      }
    }
  }

  async existsUsbWifi() {
    return await exec('lsusb -v -d 0bda: | fgrep -q Wireless').then(result => { return true;}).catch((err)=>{ return false; });
  }

  async overrideWLANKernelModule() {
    const kernelVersion = await exec('uname -r').then(result => result.stdout.trim()).catch((err) => {
      log.error(`Failed to get kernel version`, err.message);
      return null
    });
    if ( kernelVersion === null ) return;
    const koUpdated = await this.overrideKernelModule(
      WIFI_DRV_NAME,
      this.getBinaryPath()+'/'+kernelVersion,
      `/lib/modules/${kernelVersion}/kernel/drivers/net/wireless`);

    log.info(`kernel module updated is ${koUpdated}`);
    if (koUpdated) {
      // load driver if exists Realtek USB WiFi dongle
      if (this.existsUsbWifi()) {
        log.info('USB WiFi detected, loading kernel module');
        await exec(`sudo modprobe ${WIFI_DRV_NAME}`).catch((err)=>{
          log.error(`failed to load ${WIFI_DRV_NAME}`,err.message);
        });
      }
    }
    // ALWAYS reset WLAN Mac
    await this.resetWLANMac();
  }
}

module.exports = GoldPlatform;
enum TDSAnalogPin {
    //% block="P1"
    P1 = 101,
    //% block="P2"
    P2 = 102,
    //% block="P3"
    P3 = 103,
    //% block="P4"
    P4 = 104,
    //% block="P10"
    P10 = 110
}

enum TDSStatus {
    //% block="正常"
    OK = 0,
    //% block="尚未量度"
    NoReading = 1,
    //% block="尚未校準"
    NotCalibrated = 2,
    //% block="ADC 飽和或電壓超限"
    VoltageRange = 3,
    //% block="訊號不穩定"
    Unstable = 4,
    //% block="校準無效"
    BadCalibration = 5,
    //% block="超出量測範圍"
    OutOfRange = 9,
    //% block="設定無效"
    BadConfiguration = 10
}

/** SEN0244-style transfer function; hardware identity must be verified separately. */
//% color="#1479A8" icon="\uf043" block="TDS 水質計"
//% groups='["設定", "校準", "量度", "讀數", "診斷"]'
namespace tdsMeter {
    let analogPin = AnalogPin.P1;
    let configured = true;
    let referenceMV = 3300;
    let inputMultiplier = 1;
    let kValue = 1;
    let calibrated = false;
    let manualTemperature = 25;
    let busy = false;
    let lastADC = -1000;
    let lastVoltage = -1000;
    let lastTDS = -1000;
    let lastEC = -1000;
    let lastUsedTemperature = -1000;
    let spread = 0;
    let state = TDSStatus.NoReading;
    let calState = TDSStatus.NotCalibrated;

    function lock(): void { while (busy) basic.pause(5); busy = true; }
    function between(v: number, min: number, max: number): boolean { return v >= min && v <= max; }
    function invalidate(): void {
        lastTDS = -1000; lastEC = -1000; lastUsedTemperature = -1000;
        state = TDSStatus.NoReading;
    }
    function resetCalibration(): void { kValue = 1; calibrated = false; calState = TDSStatus.NotCalibrated; invalidate(); }
    function validPin(a: number): boolean { return a == AnalogPin.P1 || a == AnalogPin.P2 || a == AnalogPin.P3 || a == AnalogPin.P4 || a == AnalogPin.P10; }
    function polynomial(v: number): number { return ((133.42 * v - 255.86) * v + 857.39) * v; }

    /** Setup resets calibration, ADC scaling and supplied temperature (25 C). */
    //% blockId=tdsm_setup block="設定 TDS 腳 %pin"
    //% pin.defl=TDSAnalogPin.P1 group="設定" weight=100
    export function setup(pin: TDSAnalogPin): void {
        lock(); analogPin = <AnalogPin><number>pin;
        configured = validPin(pin);
        if (configured && (pin == TDSAnalogPin.P3 || pin == TDSAnalogPin.P4 || pin == TDSAnalogPin.P10)) led.enable(false);
        referenceMV = 3300; inputMultiplier = 1;
        manualTemperature = 25;
        lastADC = -1000; lastVoltage = -1000; spread = 0;
        resetCalibration();
        if (!configured) state = TDSStatus.BadConfiguration;
        busy = false;
    }

    /** ADC full-scale is NOT the sensor supply. Changing scaling clears calibration. */
    //% blockId=tdsm_adcconfig block="設定 ADC 滿量程 mV %fullScaleMV 訊號還原倍率 %multiplier"
    //% fullScaleMV.defl=3300 multiplier.defl=1 group="設定" weight=99 advanced=true
    export function configureADC(fullScaleMV: number, multiplier: number): boolean {
        lock();
        if (!between(fullScaleMV, 1800, 3600) || !between(multiplier, 1, 4)) {
            invalidate(); state = TDSStatus.BadConfiguration; busy = false; return false;
        }
        referenceMV = fullScaleMV; inputMultiplier = multiplier;
        lastADC = -1000; lastVoltage = -1000; resetCalibration(); busy = false; return true;
    }

    /** This value is supplied by the user, not a measured water temperature. */
    //% blockId=tdsm_manual block="輸入外部水溫 °C %temperature"
    //% temperature.defl=25 group="設定" weight=98 advanced=true
    export function setTemperature(temperature: number): boolean {
        lock(); invalidate();
        if (!between(temperature, 0, 55)) { manualTemperature = -1000; state = TDSStatus.BadConfiguration; busy = false; return false; }
        manualTemperature = temperature;
        busy = false; return true;
    }

    function sample(): TDSStatus {
        lastADC = -1000; lastVoltage = -1000; spread = 0;
        if (!configured) return TDSStatus.BadConfiguration;
        let readings: number[] = [];
        pins.analogReadPin(analogPin); basic.pause(5);
        for (let i = 0; i < 31; i++) { readings.push(pins.analogReadPin(analogPin)); basic.pause(40); }
        for (let i = 1; i < readings.length; i++) {
            let v = readings[i]; let j = i - 1;
            while (j >= 0 && readings[j] > v) { readings[j + 1] = readings[j]; j--; }
            readings[j + 1] = v;
        }
        lastADC = readings[15];
        spread = readings[29] - readings[1];
        lastVoltage = lastADC * referenceMV * inputMultiplier / 1023 / 1000;
        // Zero is legitimate for very low conductivity; software cannot distinguish a short.
        if (readings[30] >= 1021 || lastVoltage > 2.3) return TDSStatus.VoltageRange;
        if (spread > 15) return TDSStatus.Unstable;
        return TDSStatus.OK;
    }

    function resolveTemperature(): TDSStatus {
        lastUsedTemperature = manualTemperature;
        return between(manualTemperature, 0, 55) ? TDSStatus.OK : TDSStatus.BadConfiguration;
    }

    //% blockId=tdsm_calec block="校準 標準液 EC（25°C）µS/cm %standardEC25"
    //% standardEC25.defl=1413 group="校準" weight=90 advanced=true
    export function calibrateEC(standardEC25: number): boolean {
        lock(); invalidate();
        if (!between(standardEC25, 100, 2000)) {
            calState = TDSStatus.BadCalibration; busy = false; return false;
        }
        calState = sample();
        if (calState == TDSStatus.OK) calState = resolveTemperature();
        if (calState != TDSStatus.OK) { busy = false; return false; }
        let raw = polynomial(lastVoltage);
        let candidate = standardEC25 * (1 + 0.02 * (lastUsedTemperature - 25)) / raw;
        if (lastADC < 16 || !between(candidate, 0.25, 4)) {
            calState = TDSStatus.BadCalibration; busy = false; return false;
        }
        kValue = candidate; calibrated = true; calState = TDSStatus.OK;
        busy = false; return true;
    }

    /** Standard must use the 0.5 EC-to-TDS scale, referenced to 25 C. */
    //% blockId=tdsm_caltds block="校準 標準液 TDS（0.5 制、25°C）ppm %standardPPM"
    //% standardPPM.defl=706.5 group="校準" weight=89 advanced=true
    export function calibrateTDS(standardPPM: number): boolean { return calibrateEC(standardPPM * 2); }

    //% blockId=tdsm_clear block="清除 TDS 校準"
    //% group="校準" weight=88 advanced=true
    export function clearCalibration(): void { lock(); resetCalibration(); busy = false; }
    //% blockId=tdsm_calibrated block="TDS 已校準"
    //% group="校準" weight=87 advanced=true
    export function isCalibrated(): boolean { return calibrated; }
    //% blockId=tdsm_k block="TDS 校準係數 K"
    //% group="校準" weight=86 advanced=true
    export function calibrationFactor(): number { return kValue; }

    //% blockId=tdsm_export block="匯出 TDS 校準文字"
    //% group="校準" weight=85 advanced=true
    export function exportCalibration(): string {
        if (!calibrated) return "";
        return "TDS1," + referenceMV + "," + inputMultiplier + "," + kValue;
    }
    //% blockId=tdsm_restore block="載入 TDS 校準文字 %data"
    //% group="校準" weight=84 advanced=true
    export function restoreCalibration(data: string): boolean {
        lock();
        let fields = data.split(",");
        let valid = fields.length == 4 && fields[0] == "TDS1";
        for (let i = 1; valid && i < fields.length; i++) {
            let digits = 0; let dots = 0;
            for (let j = 0; j < fields[i].length; j++) {
                let c = fields[i].charAt(j);
                if (c == ".") dots++;
                else if (c >= "0" && c <= "9") digits++;
                else valid = false;
            }
            if (dots > 1 || digits == 0) valid = false;
        }
        let k = 0;
        if (valid) {
            k = parseFloat(fields[3]);
            valid = parseFloat(fields[1]) == referenceMV && parseFloat(fields[2]) == inputMultiplier && between(k, 0.25, 4);
        }
        if (valid) { kValue = k; calibrated = true; invalidate(); }
        calState = valid ? TDSStatus.OK : TDSStatus.BadCalibration;
        busy = false; return valid;
    }

    /** Fresh TDS/EC25, with the chosen temperature source. */
    //% blockId=tdsm_measure block="量度一次 TDS 及 EC"
    //% group="量度" weight=70 advanced=true
    export function measure(): void {
        lock(); invalidate();
        state = sample();
        if (state == TDSStatus.OK) state = resolveTemperature();
        if (state == TDSStatus.OK) {
            let ec = polynomial(lastVoltage) * kValue / (1 + 0.02 * (lastUsedTemperature - 25));
            if (!between(ec, 0, 2000)) state = TDSStatus.OutOfRange;
            else { lastEC = ec; lastTDS = ec * 0.5; }
        }
        busy = false;
    }
    /** Fresh estimate using the supplied water temperature; default 25 C is assumed, not measured. */
    //% blockId=tdsm_read_temperature block="量度 TDS ppm 溫度參考 °C %temperature"
    //% temperature.defl=25 temperature.min=0 temperature.max=55
    //% group="量度" weight=71
    export function readTDSAtTemperature(temperature: number = 25): number {
        if (!setTemperature(temperature)) return -1000;
        measure(); return lastTDS;
    }

    //% blockId=tdsm_read block="量度 TDS ppm"
    //% group="量度" weight=69 advanced=true
    export function readTDS(): number { measure(); return lastTDS; }
    //% blockId=tdsm_rawread block="TDS 原始數據 ADC"
    //% group="量度" weight=67
    export function readRawADC(): number { lock(); invalidate(); state = sample(); busy = false; return lastADC; }
    //% blockId=tdsm_tds block="上次 TDS（25°C）ppm"
    //% group="讀數" weight=60 advanced=true
    export function tds(): number { return lastTDS; }
    //% blockId=tdsm_ec block="上次 EC（25°C）µS/cm"
    //% group="讀數" weight=59 advanced=true
    export function ec25(): number { return lastEC; }
    //% blockId=tdsm_usedtemp block="上次換算使用的水溫 °C"
    //% group="讀數" weight=58 advanced=true
    export function temperatureUsed(): number { return lastUsedTemperature; }
    //% blockId=tdsm_raw block="上次原始 ADC"
    //% group="診斷" weight=50 advanced=true
    export function rawADC(): number { return lastADC; }
    //% blockId=tdsm_volts block="上次模組輸出電壓 V（估算）"
    //% group="診斷" weight=49 advanced=true
    export function voltage(): number { return lastVoltage; }
    //% blockId=tdsm_spread block="上次 ADC 波幅"
    //% group="診斷" weight=48 advanced=true
    export function adcSpread(): number { return spread; }
    //% blockId=tdsm_state block="TDS 狀態"
    //% group="診斷" weight=47 advanced=true
    export function status(): TDSStatus { return state; }
    //% blockId=tdsm_calstate block="上次校準操作狀態"
    //% group="診斷" weight=45 advanced=true
    export function calibrationStatus(): TDSStatus { return calState; }
    //% blockId=tdsm_statuscode block="狀態 %value"
    //% group="診斷" weight=44 advanced=true
    export function statusCode(value: TDSStatus): TDSStatus { return value; }
}

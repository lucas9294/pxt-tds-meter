// npm install --no-save typescript@5.8.3 ; node tests/run-tests.cjs
const fs=require('fs'), path=require('path'), vm=require('vm'), assert=require('assert'), ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../main.ts'),'utf8');
let checks=0;
function check(v,msg){assert.ok(v,msg);checks++;}
function near(a,b,msg){check(Math.abs(a-b)<1e-7,msg);}
function fixture(){
 let values=[300], index=0;
 const p={P0:100,P1:101,P2:102,P3:103,P4:104,P10:110,P8:108,P12:112,P13:113,P14:114,P15:115};
 const ctx={Math,parseFloat,AnalogPin:p,DigitalPin:p,basic:{pause(){}},pins:{analogReadPin(){return values[index++%values.length];}}};
 ctx.led={enable(v){ctx.ledEnabled=v;}};
 let code=source;
 vm.createContext(ctx);vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2017}}).outputText,ctx);
 return {ctx,m:ctx.tdsMeter,s:ctx.TDSStatus,adc(v){values=Array.isArray(v)?v:[v];index=0;}};
}
let h=fixture(),m=h.m,s=h.s;
check(m.readTDS()>0 && !m.isCalibrated(),'default K estimates without calibration');

check(m.calibrateEC(1413),'EC calibration');near(m.readTDS(),706.5,'1413 EC is 706.5 ppm');
near(m.ec25(),1413,'EC anchor');near(m.temperatureUsed(),25,'explicit manual default');
const original=m.exportCalibration();check(original.startsWith('TDS1,3300,1,'),'scaling in export');
h.adc(310);m.clearCalibration();check(m.calibrateTDS(500),'TDS calibration');near(m.readTDS(),500,'TDS anchor');
const base=m.readTDS();m.setTemperature(35);near(m.readTDS(),base/1.2,'EC temperature correction after polynomial');
check(m.calibrateEC(1200),'calibration temperature correction');near(m.readTDS(),600,'non25C calibration matches standard');
m.setTemperature(25);near(m.readTDS(),720,'calibration temperature retained in K');
const keep=m.exportCalibration();
for(const v of [0,99,2001,NaN,Infinity]){check(!m.calibrateEC(v),'invalid EC '+v);check(m.exportCalibration()===keep,'failed calibration preserves K');}
h.adc(0);check(!m.calibrateEC(1413),'zero cannot calibrate');near(m.readTDS(),0,'zero conductivity allowed');
h.adc(10);check(!m.calibrateEC(1413),'near zero cannot calibrate');
h.adc(1023);check(m.readTDS()===-1000 && m.status()===s.VoltageRange,'saturation');
h.adc(750);check(m.readTDS()===-1000 && m.status()===s.VoltageRange,'sensor voltage range');
h.adc([300,340]);check(m.readTDS()===-1000 && m.status()===s.Unstable,'noise');
h.adc(310);near(m.readTDS(),720,'recovers');
check(!m.setTemperature(-1),'negative application temp rejected');check(m.tds()===-1000,'settings invalidate reading');
check(!m.setTemperature(56),'hot temp rejected');check(m.setTemperature(0),'zero temp accepted');
check(m.setTemperature(55),'55C accepted');m.setTemperature(25);
for(const bad of ['','TDS1,3300,1,NaN','TDS1,3300,1,Infinity','TDS1,3300,1,1oops','TDS1,3300,1,',
 'TDS1,3300,1,0.2','TDS1,3300,1,5','TDS1,3000,1,1','TDS1,3300,2,1','TDS1,3300,1,1,2','TDS1,3300,1,-1']){
 check(!m.restoreCalibration(bad),'reject import '+bad);check(m.exportCalibration()===keep,'invalid import atomic');
}
check(m.restoreCalibration(original),'valid restore');check(m.tds()===-1000,'restore invalidates old readings');
check(!m.configureADC(5000,1),'ADC fullscale is not module 5V supply');
check(m.isCalibrated(),'invalid scaling does not clear valid calibration');
check(!m.configureADC(3300,0),'invalid multiplier');
check(m.configureADC(3300,2),'divider scaling');check(!m.isCalibrated(),'changing scale clears calibration');
h.adc(155);m.readRawADC();near(m.voltage(),1,'divider restored voltage');
check(m.calibrateEC(1000),'divider calibration');near(m.readTDS(),500,'divider measurement');
check(m.readRawADC()===155 && m.tds()===-1000,'raw invalidates converted result');
m.setup(108);check(m.readTDS()===-1000 && m.status()===s.BadConfiguration,'invalid analog pin');
m.setup(101);check(!m.isCalibrated(),'setup resets calibration');
h.adc(310);check(m.calibrateEC(1000),'calibrate with supplied temp');
check(!m.setTemperature(-1000),'reject external failure sentinel');
check(m.readTDS()===-1000 && m.status()===s.BadConfiguration,'invalid external input blocks stale compensation');
check(m.setTemperature(25),'external recovery');near(m.readTDS(),500,'restored valid input');
for(const v of [NaN,Infinity,-1,56]){check(!m.setTemperature(v),'reject invalid temperature');check(m.readTDS()===-1000,'do not reuse stale temp');}
m.setTemperature(35);near(m.readTDS(),500/1.2,'external temperature updates compensation');
check(!('readWaterTemperature' in m) && !('useAutomaticTemperature' in m),'no temperature driver API');
check(!source.includes('shim=') && !source.includes('DigitalPin'),'no native shim or temperature pin');
console.log('PASS: '+checks+' behavioral checks, mocked analog IO.');

h=fixture();m=h.m;s=h.s;
const nominal=m.readTDSAtTemperature();
near(m.readTDSAtTemperature(35),nominal/1.2,'inline temperature correction');
check(m.readTDSAtTemperature(-1000)===-1000,'invalid external sensor value rejected');
near(m.readTDSAtTemperature(),nominal,'omitted temperature resets to 25');
for(const pin of [101,102,103,104,110]){m.setup(pin);check(m.readTDSAtTemperature()>0,'allowed pin '+pin);}
check(h.ctx.ledEnabled===false,'LED disabled on shared analog pins');
m.setup(100);check(m.readTDSAtTemperature()===-1000,'P0 rejected');
check(source.split('\n').filter(x=>x.includes('//%')&&x.includes('weight=')&&!x.includes('advanced=true')).length===3,'three main blocks');
console.log('TOTAL PASS: '+checks);

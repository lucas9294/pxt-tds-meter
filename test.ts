// Default: direct analog signal, ADC full-scale 3.3V, K=1; verify module output voltage first.
tdsMeter.setup(TDSAnalogPin.P1);
input.onButtonPressed(Button.A, function () {
    serial.writeValue("estimated_TDS_ppm", tdsMeter.readTDSAtTemperature(25));
});
input.onButtonPressed(Button.B, function () {
    serial.writeValue("TDS_ADC", tdsMeter.readRawADC());
});

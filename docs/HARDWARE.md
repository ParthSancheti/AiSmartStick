# Hardware, parts and wiring

This is the wiring reference for `firmware/ai_smart_stick_v1/BoardConfig.h` (firmware 1.2.1, protocol 1). The owner's original diagnostic sketch confirms the same external GPIO assignments. The CAD was created in **Siemens NX 10**; see [CAD and enclosure files](../hardware/README.md).

## Parts list

Quantities follow the source and owner's parts description. Check module markings before buying replacements.

| Qty | Part | What is established |
|---|---|---|
| 1 | AI-Thinker ESP32-CAM with camera | Source targets ESP32-CAM, OV2640 mapping, 4 MB flash and PSRAM. Verify clone compatibility. |
| 1 | HC-SR04 ultrasonic module | One forward-facing distance beam; TRIG/ECHO interface. |
| 1 | MPU6050 breakout | I2C address `0x68`; orientation/motion input. |
| 1 | INA219 breakout | I2C address `0x40`; firmware assumes a **0.1 Ω shunt**. Verify the fitted shunt. |
| 1 | Coin vibration motor | Owner-confirmed type; rated voltage/current **not supplied**. |
| 1 | Normally open momentary button | Connects GPIO3 to GND when pressed. |
| 1 | NPN transistor motor driver | Owner reports an NPN and **no other vibration circuit components**. Transistor part unknown; see required circuit corrections below. |
| 1 set | ECHO level protection | Divider or level shifter suitable for the actual sensor output and ESP32 input limits. |
| 1 | Li-ion battery, owner-reported **2500 mAh** | Cell model, voltage, cell count and protection unconfirmed. Software expects one cell; verify the physical pack. |
| 1 | Power-bank module | Owner-confirmed generic module; exact charger/boost/protection and load-sharing capabilities unconfirmed. |
| 1 | Programmer | ESP32-CAM-MB or USB–UART adapter with **3.3 V signal levels**. |
| 1 set | Mechanical assembly | Provided enclosure meshes/native NX file; shaft, tip, screws, inserts and print settings **unconfirmed**. |
| As needed | Wiring and tools | Insulated wire, connectors, heat-shrink, soldering tools, multimeter and a current-limited bench supply for initial checks. |
| 1 + optional 1 | Android phones | User phone; separate Guardian phone for realistic pairing/notification tests. Stick setup needs Android 10+; Android SDK builds target API 36. |

Motor voltage, fasteners and print settings are unknown; the rendering cannot establish them.

## Signal connections

Switch off and disconnect all power before wiring. Connect logic/sensor/driver grounds together. Wire labels below are **GPIO numbers**, not connector pin positions.

| Device terminal | Connect to | Important detail |
|---|---|---|
| HC-SR04 VCC / GND | Verified 5 V rail / GND | Check the exact module specification and supply. |
| HC-SR04 TRIG | GPIO13 | Source uses a 3.3 V trigger; verify recognition on the actual module. |
| HC-SR04 ECHO | Level protection → GPIO12 | **Never connect a 5 V ECHO directly to ESP32 GPIO.** |
| MPU6050 SDA / SCL | GPIO14 / GPIO15 | Shared bus; `0x68`, 400 kHz. |
| INA219 SDA / SCL | GPIO14 / GPIO15 | Shared bus; `0x40`. |
| Sensor logic supplies | Verified module-compatible supply | I2C pull-ups must end at **3.3 V**. A breakout's regulator does not necessarily protect its signal pins. |
| Motor driver input | GPIO2 | Board source calls for a 10 kΩ gate pull-down for the MOSFET arrangement. |
| Button | GPIO3 ↔ button ↔ GND | Firmware enables `INPUT_PULLUP`; GPIO3 is also UART RX. |
| Optional charger STAT | Unconnected by default | `PIN_CHARGE_STAT=-1`; no confirmed physical charge-status wire. |

### ECHO protection and boot pins

The source documents this divider example:

```text
HC-SR04 ECHO -- 1 kΩ --+-- GPIO12
                       |
                      2 kΩ
                       |
                      GND
```

This nominally scales 5 V to 3.33 V. Verify rail voltage, resistor tolerances and GPIO-side voltage before connection; otherwise use a suitable level shifter. GPIO12 selects flash supply voltage at reset: ECHO must not force it HIGH. GPIO2/GPIO15 are also boot straps; external circuitry can prevent boot/programming. See [Espressif's GPIO12 guidance](https://docs.espressif.com/projects/esp-idf/en/v5.2.2/esp32/api-reference/peripherals/sd_pullup_requirements.html) and [Adafruit's HC-SR04 level explanation](https://learn.adafruit.com/ultrasonic-sonar-distance-sensors?view=all).

Do not burn eFuses as a beginner setup step. Do not add a microSD card: this design uses pins shared with that interface.

### Motor connection

The owner reports an **NPN-only driver**. That is the as-built description, not a recommended complete circuit: verify/add a calculated base resistor, base pull-down and flyback diode before rebuilding. Select them from motor current and transistor ratings; values cannot be derived from the supplied information.

The GPIO cannot power the motor. Corrected low-side NPN topology:

```text
Verified motor supply + ---- motor ----+---- NPN collector
                                      |
                     flyback diode across motor
                     cathode to supply+, anode to collector
NPN emitter -------------------------------- GND
GPIO2 --> calculated base resistor --> base
Base --> suitable pull-down --> GND
```

The source's **10 kΩ gate pull-down refers to a MOSFET alternative**, not an NPN base resistor value. Keep motor current away from sensor returns; verify starts do not reset the ESP32.

### Power and battery measurement

Use the board's regulated input with transient headroom for Wi-Fi/camera/motor. UART logic compatibility does not establish adequate supply current. Do not attach a raw cell to an arbitrary board pin.

INA219 measures battery-side voltage/current. Expected discharge path: battery positive → INA219 VIN+ → shunt → VIN− → downstream load, with shared ground and appropriate logic power. Positive current means discharge. Verify polarity, 0.1 Ω shunt and meter readings. See [INA219 high-side wiring](https://learn.adafruit.com/adafruit-ina219-current-sensor-breakout/wiring?view=all).

**Power-bank module wiring remains unverified.** Confirm its charger, protection, boost and load-sharing functions; wrong shunt placement invalidates charging inference. The old sketch's voltage-only charging test is not a charger or protection controller.

## First electrical checks

1. Verify polarity, continuity and absence of shorts without power; inspect ECHO protection and motor diode orientation.
2. Power the board from a verified supply before attaching the battery system. Check 5 V/3.3 V rails with a meter.
3. Connect sensors one at a time; verify I2C devices at `0x68`/`0x40` and compare sonar distances against measured targets.
4. Check the motor through its driver; watch for resets, hot components and voltage collapse.
5. Validate battery measurement/calibration and the actual charger topology before battery operation.
6. Mount electronics only after bench checks. Recheck camera/sonar alignment, IMU orientation, cable strain relief, button access and antenna clearance.

Detailed flashing, camera mapping and local mode tests are in [Firmware setup](FIRMWARE_SETUP.md). Continue with [the complete build guide](BUILD_GUIDE.md).

# Android Virtual Device lifecycle

`serve-droid` keeps installed AVDs separate from devices that are already visible through ADB. It
never creates an AVD, downloads a system image, or accepts an Android SDK license on your behalf.

## Prerequisites

Install Android Emulator and at least one system image through Android Studio's SDK Manager, then
create an AVD in Device Manager. Follow Android's official
[AVD management guide](https://developer.android.com/studio/run/managing-avds).

The emulator executable is resolved from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then `PATH`. AVD
metadata is read from `ANDROID_AVD_HOME` or the platform's default `.android/avd` directory.

## Commands

```sh
serve-droid avd list
serve-droid avd start Pixel_8
serve-droid avd start Pixel_8 --headless --cold-boot
serve-droid avd stop emulator-5554
```

Every command supports `--json`. `avd start` accepts an exact installed name only. If its configured
system image is absent, serve-droid stops before launch and points back to Android Studio's SDK
Manager. A data reset is intentionally destructive and therefore requires both `--wipe-data` and
`--yes`.

On macOS and Linux an emulator starts as a detached process; on Windows it is detached without a
console window. `avd stop` accepts an ADB serial, refuses physical devices, and sends the emulator
console stop command through only the selected ADB transport.

After an AVD boots and appears in `serve-droid devices`, start its cockpit normally:

```sh
serve-droid start emulator-5554
```

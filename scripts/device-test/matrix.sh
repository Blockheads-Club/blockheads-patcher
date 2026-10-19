#!/bin/bash
# Per-patch device matrix: each patch + fix-system-font-crash + fix-config-change-crash; launch, Play, 35 s in world.
# Usage: ADB_SERIAL=<usb serial> BH_APK=<1.7.6 apk> [BH_DISPLAY=<screencap display id>] scripts/device-test/matrix.sh <patchId...>
# Assumes an existing world on the main menu and the Play button at the Fold4 cover-screen position.
S=$(cd "$(dirname "$0")/../.." && pwd)/.local-out/device-test
W=$(cd "$(dirname "$0")/../.." && pwd)
A="adb -s ${ADB_SERIAL:?set ADB_SERIAL (USB serial)}"; P=com.noodlecake.blockheads
: "${BH_APK:?set BH_APK to the original 1.7.6 APK}"
cd $W
for id in "$@"; do
  out=$S/matrix/$id; mkdir -p $out
  b=$(bun scripts/device-test/build.ts m-$id fix-system-font-crash fix-config-change-crash $id 2>&1 | tail -1)
  inst=$($A install -r .local-out/device-test/m-$id.apk 2>&1 | tail -1)
  $A shell am force-stop $P; $A logcat -c
  $A shell monkey -p $P -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 25
  $A exec-out screencap ${BH_DISPLAY:+-d $BH_DISPLAY} -p > $out/menu.png
  w=$(python3 -I -c "import struct,sys;d=open(sys.argv[1],'rb').read(24);print(struct.unpack('>I',d[16:20])[0])" $out/menu.png)
  if [ "$w" -gt 1500 ]; then $A shell input tap 1436 778; else $A shell input tap 452 1782; fi
  sleep 35
  $A exec-out screencap ${BH_DISPLAY:+-d $BH_DISPLAY} -p > $out/world.png
  pid=$($A shell pidof $P)
  $A logcat -d > $out/logcat.txt
  world=$(grep -a -c 'loading world with size' $out/logcat.txt)
  fatal=$(grep -a -c -E 'Fatal signal|FATAL EXCEPTION' $out/logcat.txt)
  echo "$id | build=${b:0:40} | install=$inst | pid=${pid:-none} | world=$world | fatal=$fatal" | tee -a $S/matrix/results.txt
done

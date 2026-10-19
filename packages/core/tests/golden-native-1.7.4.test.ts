// One test file per game version, so the versions run in parallel (the suite is in golden-native.suite.ts).
import { goldenNativeSuite } from './golden-native.suite';

goldenNativeSuite('1.7.4');

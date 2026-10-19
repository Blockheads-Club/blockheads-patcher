// One test file per game version, so the versions run in parallel (the suite is in golden.suite.ts).
import { goldenSuite, goldenExtras } from './golden.suite';

goldenSuite('1.7.4');
goldenExtras();

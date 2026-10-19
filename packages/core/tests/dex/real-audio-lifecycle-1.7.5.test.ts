// One test file per game version, so the versions run in parallel (the suite is in real-audio-lifecycle.suite.ts).
import { audioLifecycleSuite } from './real-audio-lifecycle.suite';

audioLifecycleSuite('1.7.5');

#!/usr/bin/env node
// Retired probe: unsafe legacy asset/funding assumptions; never sign or cancel.
import { refuseLegacyProbe } from './ops-probe-safety.js';
refuseLegacyProbe();

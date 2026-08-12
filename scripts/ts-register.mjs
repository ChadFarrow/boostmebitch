// Registers ./ts-resolve-hooks.mjs. Used as `node --import ./scripts/ts-register.mjs`.
// Node requires resolve hooks to live in their own module, hence the two files.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-resolve-hooks.mjs', pathToFileURL(import.meta.dirname + '/'));

/**
 * Applies the stored colour theme before the window's first paint.
 *
 * Built as its own classic script and loaded first in <head>, because the module renderer runs
 * only after the page has parsed and painted: a light-theme window would otherwise flash dark on
 * every start. The page's policy allows only its own scripts, so this cannot be inline.
 */
import { applyColorTheme, readColorTheme } from './color-theme.ts';

applyColorTheme(readColorTheme());

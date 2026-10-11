'use strict';

/** Escape user input before using it as a literal MongoDB regular expression. */
function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = escapeRegex;

'use strict';

const sanitizeHtml = require('sanitize-html');

const safeInlineStyles = {
  color: [/^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9\s.,%+-]+\)|[a-z]{1,24})$/i],
  'background-color': [/^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9\s.,%+-]+\)|[a-z]{1,24})$/i],
  'font-size': [/^\d{1,3}(?:px|pt|em|rem|%)$/i],
  'font-weight': [/^(?:normal|bold|[1-9]00)$/i],
  'font-style': [/^(?:normal|italic|oblique)$/i],
  'text-align': [/^(?:left|right|center|justify)$/i],
  'text-decoration': [/^(?:none|underline|line-through)$/i],
  'line-height': [/^\d{1,3}(?:\.\d{1,3})?(?:px|pt|em|rem|%)?$/i],
  'font-family': [/^[\w\s,'"-]{1,120}$/i],
  'margin': [/^(?:auto|0|\d{1,3}(?:px|pt|em|rem|%)?)(?:\s+(?:auto|0|\d{1,3}(?:px|pt|em|rem|%)?)){0,3}$/i],
  'padding': [/^\d{1,3}(?:px|pt|em|rem|%)(?:\s+\d{1,3}(?:px|pt|em|rem|%)){0,3}$/i],
  'border': [/^(?:none|\d{1,2}px\s+(?:solid|dashed|dotted)\s+(?:#[0-9a-f]{3,8}|[a-z]{1,24}))$/i],
  'border-radius': [/^\d{1,3}(?:px|em|rem|%)$/i],
};

const baseOptions = {
  allowedTags: [
    'a', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt',
    'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p',
    'pre', 's', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead',
    'tr', 'u', 'ul',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel', 'title', 'class', 'style'],
    img: ['src', 'alt', 'title', 'width', 'height', 'class', 'style'],
    '*': ['class', 'style', 'align'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
  },
  allowedStyles: safeInlineStyles,
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https'] },
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => {
      const next = { ...attribs };
      if (next.target === '_blank') next.rel = 'noopener noreferrer nofollow';
      else delete next.target;
      return { tagName, attribs: next };
    },
  },
};

function sanitizeRichHtml(value) {
  if (typeof value !== 'string' || !value) return '';
  return sanitizeHtml(value, baseOptions);
}

function sanitizeEmailHtml(value) {
  if (typeof value !== 'string' || !value) return '';
  return sanitizeHtml(value, {
    ...baseOptions,
    allowedTags: [...baseOptions.allowedTags, 'center', 'small', 'strike'],
    allowedAttributes: {
      ...baseOptions.allowedAttributes,
      table: ['class', 'style', 'align', 'width', 'cellpadding', 'cellspacing', 'border'],
      td: ['class', 'style', 'align', 'valign', 'width', 'colspan', 'rowspan'],
      th: ['class', 'style', 'align', 'valign', 'width', 'colspan', 'rowspan'],
      img: ['src', 'alt', 'title', 'width', 'height', 'class', 'style'],
    },
  });
}

module.exports = { sanitizeRichHtml, sanitizeEmailHtml };

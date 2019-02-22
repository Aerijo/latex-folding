const { Point, Range } = require("atom");

const FOLD_POSITIONS = /^[ \t]*\\((?:sub){0,2}section|chapter|part|(?:sub)?paragraph|begin|documentclass)\b/;

// LOOK at `render` in TextEditorComponent #3206
module.exports = {
  activate() {
    if (!atom.packages.isPackageLoaded("atom-folding")) {
      require("atom-package-deps").install("latex-folding");
    }
  },

  provideFolding () {
    return {
      scope: "text.tex.latex",
      allowDefaultFolds: false, // need to clean up getFoldableRangeContainingPoint when default folding inside of section / env
      isFoldableAtRow: isFoldableAtRow,
      getFoldableRangeContainingPoint: getFoldableRangeContainingPoint,
      getFoldableRangesAtIndentLevel: getFoldableRangesAtIndentLevel
    };
  }
};

function isFoldableAtRow ({row, editor}) {
  const line = editor.lineTextForBufferRow(row);
  return FOLD_POSITIONS.test(line);
}

function getFoldableRangesAtIndentLevel ({level, editor}, startRow=0, endRow=-1, ranges=[]) {
  if (endRow < 0) endRow = editor.getLineCount();

  for (let row = startRow; row < endRow; row++) {
    if (!isFoldableAtRow({row, editor})) continue;

    const range = getFoldableRangeContainingPoint({point: {row: row, column: Infinity}, editor});
    if (range === null) continue;

    if (level > 0) {
      getFoldableRangesAtIndentLevel({level: level - 1, editor}, range.start.row + 1, range.end.row, ranges);
    } else {
      ranges.push(range);
    }
  }

  return ranges;
}

function getFoldableRangeContainingPoint ({point, editor}) {
  let line, match = null;
  let row = point.row;

  for (; row >= 0; row--) {
    line = editor.lineTextForBufferRow(row);
    match = line.match(FOLD_POSITIONS);

    if (match) break;
  }
  if (match === null) return null;

  const foldCommand = match[1];

  let range;
  switch (foldCommand) {
    case "begin":
      range = getEnvRange(editor, row, atom.config.get("latex-folding.lenientEnvironmentEnds"));
      break;
    case "documentclass":
      range = getPreambleRange(editor, row);
      break;
    default:
      range = getSectionRange(editor, row, foldCommand);
  }

  if (!range) return null;
  return range.start.row >= range.end.row ? null : range;
}

function getPreambleRange (editor, row) {
  let startPoint = new Point(row, editor.buffer.lineLengthForRow(row));
  let endPoint = null;

  const searchRegex = /\\begin\s*\{\s*document\s*\}/g;
  const scanRange = new Range(startPoint, editor.buffer.getEndPosition());
  editor.scanInBufferRange(searchRegex, scanRange, ({range, stop}) => {

    let scopeArray = editor.scopeDescriptorForBufferPosition(range.start).scopes;
    if (isCommented(scopeArray)) { return; }

    endPoint = new Point(range.start.row - 1, Infinity);
    stop();
  });

  if (endPoint === null) {
    endPoint = editor.buffer.getEndPosition();
  }

  return new Range(startPoint, endPoint);
}

function getSectionRange (editor, row, sectionType) {
  let line = editor.lineTextForBufferRow(row);
  let sectionMatch = line.match(/^[ \t]*(?:\\((?:sub){0,2}section|chapter|part|(?:sub)?paragraph)\s*\*?\s*(\[.*?\])?\{([^\}]*\})?)/);

  if (sectionMatch === null) {
    atom.notifications.addWarning("Cannot fold this section!", { dismissable: true });
    return;
  }

  let endPosition = editor.buffer.getEndPosition();

  let levelTable = {
    "part": -1,
    "chapter": 0,
    "section": 1,
    "subsection": 2,
    "subsubsection": 3,
    "paragraph": 4,
    "subparagraph": 5
  };

  let startLevel = levelTable[sectionType];
  let sectionRange = null;

  let startPoint = new Point(row, sectionMatch[0].length);
  let searchRegex = /(?:\\((?:sub){0,2}section|chapter|part|(?:sub)?paragraph)\s*\*?\s*(\[.*?\])?\{([^\}]*\})?)|(?:\\end\s*\{\s*document\s*\})/g;

  let scanRange = new Range(startPoint, endPosition);

  let nextSectionCommandRange;
  let matchFound = false;

  editor.scanInBufferRange(searchRegex, scanRange, ({match, range, stop}) => {
    let command = match[1];

    if (startLevel < levelTable[command]) { return; }

    let scopeArray = editor.scopeDescriptorForBufferPosition(range.start).scopes;
    if (isCommented(scopeArray)) { return; }

    nextSectionCommandRange = range;
    matchFound = true;
    stop();
  });

  if (matchFound) {
    sectionRange = new Range(startPoint, nextSectionCommandRange.start.translate(new Point(-1, Infinity)));
  } else {
    sectionRange = new Range(startPoint, endPosition);
  }

  if (!atom.config.get("latex-folding.foldTrailingSectionWhitespace")) {
    translateEndRowToLastNonWhitespaceLine(sectionRange, editor);
  }

  return sectionRange.start.row >= sectionRange.end.row ? null : sectionRange;
}

function translateEndRowToLastNonWhitespaceLine (range, editor) {
  for (let i = range.end.row; i > range.start.row; i--) {
    const line = editor.lineTextForBufferRow(i);
    if (/\S/.test(line)) {
      range.end.row = i;
      range.end.column = Infinity;
      return;
    };
  }

  range.end = range.start; // makes it invalid as a fold
}

function getEnvRange (editor, row, lenientEnvNames=false) {
  let line = editor.lineTextForBufferRow(row);
  let envMatch = line.match(/^[ \t]*\\begin\s*\{(.*?)\}/);
  if (envMatch === null) {
    atom.notifications.addWarning("Cannot find start of this env!", { dismissable: true });
    return;
  }

  let endPosition = editor.buffer.getEndPosition();

  const ENV_NAME = envMatch[1];

  const SEARCH_NAME = lenientEnvNames ? '.*?' : escape(ENV_NAME);

  let startPoint = new Point(row, envMatch[0].length);
  let searchRegex = new RegExp(`\\\\(begin|end)\\{${SEARCH_NAME}\\}`, 'g');

  let scanRange = new Range(startPoint, endPosition);

  let nestedCounter = 0;
  let endDelimRange;
  let matchFound = false;
  editor.scanInBufferRange(searchRegex, scanRange, ({ match, range, stop }) => {
    let scopeArray = editor.scopeDescriptorForBufferPosition(range.start).scopes;
    if (isCommented(scopeArray)) { return; }

    let type = match[1];
    if (type === "begin") { nestedCounter += 1; return; }

    if (nestedCounter > 0) { nestedCounter -= 1; return; }

    endDelimRange = range;
    matchFound = true;
    stop();
  });

  if (!matchFound) {
    atom.notifications.addWarning(`Closing delimiter for environment \`${ENV_NAME}\` not found`, { dismissable: true });
    return;
  }

  return new Range(startPoint, endDelimRange.start);
}

function isCommented (scopesArray) {
  for (let scope of scopesArray) {
    if (scope.startsWith("comment")) { return true; }
  }
  return false;
}

function escape (text) {
  return text.replace(/\W/g, c => '\\' + c);
}

const { Point, Range, CompositeDisposable } = require("atom");

const FOLD_POSITIONS = /^[ \t]*\\((?:sub){0,2}section|chapter|part|(?:sub)?paragraph|begin)\b/;

const editorInfo = new Map();

// LOOK at `render` in TextEditorComponent #3206
module.exports = {
  activate() {
    this.disposables = new CompositeDisposable();
    this.disposables.add(
      atom.workspace.observeTextEditors((editor) => {

        editorInfo.set(editor.id, {
          hooked: false
        });

        editor.observeGrammar((grammar) => {
          if (grammar.scopeName === "text.tex.latex") {
            addFoldingRules(editor);
          } else {
            removeFoldingRules(editor);
          }
        });
      })
    );
  },

  deactivate() {
    if (this.disposables) {
      this.disposables.dispose();
    }
  }
};

function addFoldingRules(editor) {
  let context = editorInfo.get(editor.id);

  if (context.hooked) return;

  context.hooked = true;

  const languageMode = editor.languageMode;

  context.languageMode = languageMode;

  context.origIsFoldableAtRow = languageMode.isFoldableAtRow;
  context.origGetFoldableRangeContainingPoint = languageMode.getFoldableRangeContainingPoint;
  context.getFoldableRangesAtIndentLevel = languageMode.getFoldableRangesAtIndentLevel;

  languageMode.isFoldableAtRow = (row) => isFoldableAtRow(row, editor);
  languageMode.getFoldableRangeContainingPoint = (point, tabLength) => getFoldableRangeContainingPoint(point, editor);
  languageMode.getFoldableRangesAtIndentLevel = (level, tabLength) => getFoldableRangesAtIndentLevel(level, editor);
}

function removeFoldingRules(editor) {
  let context = editorInfo.get(editor.id);
  if (context && context.hooked) {
    context.hooked = false;

    const languageMode = editor.languageMode;

    if (context.languageMode === languageMode) {
      languageMode.isFoldableAtRow = context.isFoldableAtRow;
      languageMode.origGetFoldableRangeContainingPoint = context.getFoldableRangeContainingPoint;
      languageMode.getFoldableRangesAtIndentLevel = context.getFoldableRangesAtIndentLevel;
    }
  }
}

function getFoldableRangesAtIndentLevel (level, editor, startRow=0, endRow=-1, ranges=[]) {
  if (endRow < 0) endRow = editor.getLineCount();

  for (let row = startRow; row < endRow; row++) {
    if (!isFoldableAtRow(row, editor)) continue;

    const range = getFoldableRangeContainingPoint({row: row, column: Infinity}, editor);
    if (range === null) continue;

    if (level > 0) {
      getFoldableRangesAtIndentLevel(level - 1, editor, range.start.row + 1, range.end.row, ranges);
    } else {
      ranges.push(range);
    }
  }

  return ranges;
}

function isFoldableAtRow (row, editor) {
  const line = editor.lineTextForBufferRow(row);
  return FOLD_POSITIONS.test(line);
}

function getFoldableRangeContainingPoint (point, editor) {
  let line, match = null;
  let row = point.row;

  for (; row >= 0; row--) {
    line = editor.lineTextForBufferRow(row);
    match = line.match(FOLD_POSITIONS);

    if (match) break;
  }
  if (match === null) return null;

  const foldCommand = match[1];
  const range = foldCommand === "begin" ? getEnvRange(editor, row) : getSectionRange(editor, row, foldCommand);
  if (range === null) return null;
  return range.start.row === range.end.row ? null : range;
}

function getSectionRange(editor, row, sectionType) {
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

  let nestedCounter = 0;
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

  if (!matchFound) {
    return sectionRange = new Range(startPoint, endPosition);
  }


  sectionRange = new Range(startPoint, nextSectionCommandRange.start);

  if (sectionRange.start.row >= sectionRange.end.row - 1) return null;

  sectionRange.end = new Point(sectionRange.end.row - 1, Infinity);

  return sectionRange;
}

function getEnvRange(editor, row, lenientEnvNames=false) {
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

function isCommented(scopesArray) {
  for (let scope of scopesArray) {
    if (scope.startsWith("comment")) { return true; }
  }
  return false;
}

function escape (text) {
  return text.replace(/\W/, c => '\\' + c);
}

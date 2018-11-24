const { Point, Range, CompositeDisposable } = require("atom");

const FOLD_POSITIONS = /^[ \t]*\\((?:sub){0,2}section|chapter|part|(?:sub)?paragraph|begin)\b/;

const editorInfo = new Map();

/**
* Event capture technique drawn from `custom-folds`.
* The space-pen-views trick is especially weird, it seems to affect execution order of callbacks.
* I may make a PR to custom-folds to add better existing selections support,
* but for now I'm going to focus on improving this and generalising it to be
* a proper custom folds consumer (with LaTeX as just one of many providers).
*/

// LOOK at `render` in TextEditorComponent #3206
module.exports = {
  activate() {

    console.log("Loaded latex-folding");

    this.disposables = new CompositeDisposable();
    this.observedEditors = [];
    this.disposables.add(

      atom.config.observe("latex-folding.allowSameLineFolds", (value) => {

      }),

      atom.workspace.observeTextEditors((editor) => {

        editorInfo.set(editor.id, {
          lastSelections: [],
          sectionMarkers: [],
          disposables: new CompositeDisposable(),
          hooked: false
        });

        function mouseDown(ev) {
          return toggleFold(ev, editor);
        }

        editor.observeGrammar((grammar) => {
          if (grammar.scopeName === "text.tex.latex") {
            addFoldingRules(editor, mouseDown);
          } else {
            removeFoldingRules(editor, mouseDown);
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

function isFoldableAtRow (row, editor) {
  if (row === 0) debugger;
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
  return foldCommand === "begin" ? getEnvRange(editor, row) : getSectionRange(editor, row, foldCommand);
}

function addFoldingRules(editor, mouseDown) {
  let context = editorInfo.get(editor.id);

  if (context.hooked) { console.warn("latex-folding: already hooked"); return; }
  context.hooked = true;

  const languageMode = editor.languageMode;

  context.languageMode = languageMode;

  context.origIsFoldableAtRow = languageMode.isFoldableAtRow;
  context.origGetFoldableRangeContainingPoint = languageMode.getFoldableRangeContainingPoint;

  languageMode.isFoldableAtRow = (row) => isFoldableAtRow(row, editor);
  languageMode.getFoldableRangeContainingPoint = (point, tabLength) => getFoldableRangeContainingPoint(point, editor);
}

function removeFoldingRules(editor, mouseDown) {
  let context = editorInfo.get(editor.id);
  if (context && context.hooked) {
    context.hooked = false;

    const languageMode = editor.languageMode

    if (context.languageMode === languageMode) {
      languageMode.isFoldableAtRow = context.isFoldableAtRow
      languageMode.origGetFoldableRangeContainingPoint = context.getFoldableRangeContainingPoint
    }

    context.disposables.dispose();
  }
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
  let sectionRange;

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
    sectionRange = new Range(startPoint, endPosition);
  } else {
    sectionRange = new Range(startPoint, nextSectionCommandRange.start);
  }

  return sectionRange;
}

function getEnvRange(editor, row) {
  let line = editor.lineTextForBufferRow(row);
  let envMatch = line.match(/^[ \t]*\\begin\s*\{(.*?)\}/);
  if (envMatch === null) {
    atom.notifications.addWarning("Cannot find start of this env!", { dismissable: true });
    return;
  }

  let endPosition = editor.buffer.getEndPosition();

  const ENV_NAME = envMatch[1];

  let startPoint = new Point(row, envMatch[0].length);
  let searchRegex = new RegExp(`\\\\(begin|end)\\{${ENV_NAME}\\}`);

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

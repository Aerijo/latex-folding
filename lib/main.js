const { Point, Range, CompositeDisposable } = require("atom");
const { $ } = require('atom-space-pen-views'); // I think this is jQuery?

const CUSTOM_FOLD_SELECTOR = '.line-number.custom-latex-fold:not(.folded) .icon-right';
const UNFOLD_SELECTOR = '.folded .icon-right';
const FOLD_POSITIONS = /^[ \t]*\\((?:sub){0,2}section|chapter|part|(?:sub)?paragraph|begin)(?=\b.*$)/;
const FOLD_POSITIONS_G = new RegExp(FOLD_POSITIONS, "g");
const editor_info = new Map();

/**
* Event capture technique drawn from `custom-folds`.
* The space-pen-views trick is especially weird, it seems to affect execution order of callbacks.
* I may make a PR to custom-folds to add better existing selections support,
* but for now I'm going to focus on improving this and generalising it to be
* a proper custom folds consumer (with LaTeX as just one of many providers).
*/

module.exports = {
  config: {
    allowSameLineFolds: {
      description: "Enable this to allow folds to start and end on the same line.",
      type: "boolean",
      default: false
    }
  },
  activate() {
    this.disposables = new CompositeDisposable();
    this.observedEditors = [];
    this.disposables.add(
      atom.config.observe("latex-folding.allowSameLineFolds", (value) => {

      }),
      atom.workspace.observeTextEditors((editor) => {

        editor_info.set(editor.id, {
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

function addFoldingRules(editor, mouseDown) {
  let context = editor_info.get(editor.id);

  if (context.hooked) { console.warn("latex-folding: already hooked"); return; }
  context.hooked = true;

  $(editor.lineNumberGutter.element).on('mousedown', CUSTOM_FOLD_SELECTOR, mouseDown);
  $(editor.lineNumberGutter.element).on('mousedown', UNFOLD_SELECTOR, mouseDown);

  context.sectionMarkers = [];

  setMarkers(editor, context);
  context.disposables.add(editor.onDidStopChanging(
    () => { setMarkers(editor, context); }
  ));

}

function removeFoldingRules(editor, mouseDown) {
  let context = editor_info.get(editor.id);
  if (context && context.hooked) {
    context.hooked = false;
    context.sectionMarkers.map(marker => marker.destroy());
    context.sectionMarkers = [];

    $(editor.lineNumberGutter.element).off('mousedown', CUSTOM_FOLD_SELECTOR, mouseDown);
    $(editor.lineNumberGutter.element).off('mousedown', UNFOLD_SELECTOR, mouseDown);

    context.disposables.dispose();
  }
}

function setMarkers(editor, context) {
  let lineGutter = editor.lineNumberGutter;

  // first we remove all the existing markers
  context.sectionMarkers.map(marker => marker.destroy());
  context.sectionMarkers = [];

  editor.scan(FOLD_POSITIONS_G, ({ match, range, stop }) => {
    /**
    * This is where we set up the folding markers.
    * A problem with the straightforward approach is that soft wrapped lines
    * would get the arrow on the line containing the range, but native folding
    * places the arrow on the last line.
    *
    * As the goal is to make this a seamless experience, we use the following technique:
    * - Make a marker at the range that indicates a fold is possible
    * - Make a secondary marker on the same row, but translated to the end of the buffer row
    * - Set this second marker to self destruct when the first one does
    * - Set the first one to reinspect itself whenever it changes
    * - Add a decoration to the second one, so it will always be on the final line when soft wrapped
    */
    let sectionMarker = editor.markBufferRange(range, { invalidate: "touch" });
    let lineMarker = editor.markBufferPosition([range.start.row, Infinity], { invalidate: "never" });

    sectionMarker.onDidChange((event) => {
      if (!editor.lineTextForBufferRow(event.newHeadBufferPosition.row).match(FOLD_POSITIONS)) {
        sectionMarker.destroy();
      }
    });
    sectionMarker.onDidDestroy(() => {
      lineMarker.destroy();
    });

    context.sectionMarkers.push(sectionMarker);
    lineGutter.decorateMarker(lineMarker, {
      type: "line-number",
      class: "foldable custom-latex-fold" // `foldable` prevents selection of line
    });
  });
}

function toggleFold(ev, editor) {
  const { target, button } = ev;
  if (button !== 0) { return; } // only respond to left click

  let context = editor_info.get(editor.id);

  const clickedScreenPoint = editor.component.screenPositionForMouseEvent(event);
  const clickedBufferPoint = editor.bufferPositionForScreenPosition(clickedScreenPoint);
  const row = clickedBufferPoint.row;

  if (target.matches(".folded .icon-right")) {
    unfoldRow(editor, context, row);
  } else {
    foldRow(editor, context, row);
  }
}

function unfoldRow(editor, context, row) {
  let disp = editor.displayLayer;
  let folds = disp.foldsMarkerLayer.getMarkers();
  let foldsOnRow = folds.filter(marker => marker.getRange().start.row === row);
  editor.displayLayer.destroyFoldMarkers(foldsOnRow);
}

function foldRow(editor, context, row) {
  if (editor.isFoldedAtBufferRow(row)) { editor.unfoldBufferRow(row); } // the row will only be folded when the native folding just did it before us

  let foldCommand = getFoldingCommand(editor, row);
  let foldRange = foldCommand === "begin" ? getEnvRange(editor, row) : getSectionRange(editor, row, foldCommand);

  if (!foldRange || foldRange.isEmpty()) { return; } // possible if there is no closing env delim, etc.
  if (foldRange.isSingleLine()) {
    if (!atom.config.get("latex-folding.allowSameLineFolds")) {
      atom.notifications.addWarning("Same line folding has been disabled", { dismissable: true });
      return;
    }
  } else { // makes it look nicer / keeps section commands on their own lines
    foldRange = foldRange.translate([0,Infinity], [-1,Infinity]);
  }

  foldRange = editor.clipBufferRange(foldRange); // prevents weird bug when ends with Infinity
  if (foldRange.isEmpty()) { return; }

  editor.foldBufferRange(foldRange);
}

function getSectionRange(editor, row, sectionType) {
  let line = editor.lineTextForBufferRow(row);
  let sectionMatch = line.match(/^[ \t]*(?:\\((?:sub){0,2}section|chapter|part|(?:sub)?paragraph)\s*\*?\s*(\[.*?\])?\{([^\}]*\})?)/);

  if (sectionMatch === null) {
    atom.notifications.addWarning("Cannot fold this section!", { dismissable: true });
    return;
  }

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

  let scanRange = new Range(startPoint, [Infinity, Infinity]);

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
    sectionRange = new Range(startPoint, [Infinity, Infinity]);
  } else {
    sectionRange = new Range(startPoint, nextSectionCommandRange.start);
  }

  return sectionRange;
}

function getFoldingCommand(editor, row) {
  return editor.lineTextForBufferRow(row).match(FOLD_POSITIONS)[1];
}

function getEnvRange(editor, row) {
  let line = editor.lineTextForBufferRow(row);
  let envMatch = line.match(/^[ \t]*\\begin\s*\{(.*?)\}/);
  if (envMatch === null) {
    atom.notifications.addWarning("Cannot find start of this env!", { dismissable: true });
    return;
  }
  const ENV_NAME = envMatch[1];

  let startPoint = new Point(row, envMatch[0].length);
  let searchRegex = new RegExp(`\\\\(begin|end)\\{${ENV_NAME}\\}`);

  let scanRange = new Range(startPoint, [Infinity, Infinity]);

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

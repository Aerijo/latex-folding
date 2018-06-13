const { CompositeDisposable } = require("atom");
const { ScopeSelector } = require("first-mate");
const { Point, Range } = require("atom");
const { $ } = require('atom-space-pen-views');

const CUSTOM_FOLD_SELECTOR = '.line-number.custom-latex-fold:not(.folded) .icon-right';
const FOLD_POSITIONS = /^[ \t]*\\((?:sub){0,2}section|chapter|part|(?:sub)?paragraph|begin)(?=\b.*$)/;
const FOLD_POSITIONS_G = new RegExp(FOLD_POSITIONS, "g");
const commentScopeSelector = new ScopeSelector("comment.*");
const editor_info = new Map();

// Heavily drawn from `custom-folds`. The space-pen-views trick is especially weird, it seems to affect execution order of callbacks.
// I may make a PR to custom-folds to add better existing selections support, but for now I'm going to focus on improving this
// and generalising it to be a proper custom folds consumer (with LaTeX as just one of many providers).


module.exports = {
  activate() {
    this.disposables = new CompositeDisposable();
    this.observedEditors = [];
    this.disposables.add(
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

        function mouseEnter(ev) {
          // clicking our custom element deletes selections, so we remember them with this
          editor_info.get(editor.id).lastSelections = editor.getSelectedBufferRanges();
        }

        editor.observeGrammar((grammar) => {
          if (grammar.scopeName === "text.tex.latex") {
            addFoldingRules(editor, mouseEnter, mouseDown);
          } else {
            removeFoldingRules(editor, mouseEnter, mouseDown);
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

function toggleFold(ev, editor) {
  const { target, button } = ev;

  // console.log(editor);
  // console.log(editor.displayLayer.foldsMarkerLayer);

  // debugger;

  if (button !== 0) { return; }

  let context = editor_info.get(editor.id);

  const clickedScreenPos = editor.component.screenPositionForMouseEvent(event);
  const clickedBufferPoint = editor.bufferPositionForScreenPosition(clickedScreenPos);
  const row = clickedBufferPoint.row;

  // if (editor.isFoldedAtBufferRow(row)) { return; }

  let foldedCommand = getFoldingCommand(editor, row);
  let foldRange;

  if (foldedCommand === "begin") {
    foldRange = getEnvRange(editor, row);
  } else {
    foldRange = getSectionRange(editor, row, foldedCommand);
  }

  if (!foldRange) { return; }
  if (foldRange.isEmpty()) { return; }
  if (!foldRange.isSingleLine()) {
    foldRange = foldRange.translate([0,Infinity], [-1,Infinity]);
  }
  if (foldRange.isEmpty()) { return; }

  // editor.foldBufferRange(foldRange);     // not used because native folding then folds the rest if the end is indented
  editor.setSelectedBufferRange(foldRange); // convoluted, but circumvents bug / glitch with native indentation folding
  editor.foldSelectedLines();
  editor.setSelectedBufferRanges(context.lastSelections, { preserveFolds: true });

}

function setMarkers(editor, context) {
  let gutter = editor.lineNumberGutter;

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
    * - Make a secondary marker tied to this one, but translated to the end of the buffer row
    * - Set this second marker to self destruct when the first one does
    * - Set the first one to reinspect itself whenever it changes
    * - Add a decoration to the second one, so it will always be on the final line when soft wrapped
    */
    let sectionMarker = editor.markBufferRange(range, { invalidate: "touch" });
    let lineMarker = editor.markBufferRange(range.translate([0, Infinity]), { invalidate: "never" });

    sectionMarker.onDidChange((event) => {
      if (!editor.lineTextForBufferRow(event.newHeadBufferPosition.row).match(FOLD_POSITIONS)) {
        sectionMarker.destroy();
      }
    });
    sectionMarker.onDidDestroy(() => {
      lineMarker.destroy();
    });

    context.sectionMarkers.push(sectionMarker);
    let decor = gutter.decorateMarker(lineMarker, {
      type: "line-number",
      class: "custom-latex-fold"
    });

    // console.log(decor);
  });
}

function addFoldingRules(editor, mouseEnter, mouseDown) {
  let context = editor_info.get(editor.id);

  if (context.hooked) { console.warn("already hooked"); return; }
  context.hooked = true;

  $(editor.lineNumberGutter.element).on('mousedown', CUSTOM_FOLD_SELECTOR, mouseDown);
  $(editor.lineNumberGutter.element).on("mouseenter", mouseEnter);

  context.sectionMarkers = [];

  setMarkers(editor, context);
  context.disposables.add(editor.onDidStopChanging(
    () => { setMarkers(editor, context); }
  ));

}

function removeFoldingRules(editor, mouseEnter, mouseDown) {
  let context = editor_info.get(editor.id);
  if (context && context.hooked) {
    context.hooked = false;
    context.sectionMarkers.map(marker => marker.destroy());

    $(editor.lineNumberGutter.element).off('mousedown', CUSTOM_FOLD_SELECTOR, mouseDown);
    $(editor.lineNumberGutter.element).off("mouseenter", mouseEnter);

    context.disposables.dispose();
  }
}

function getSectionRange(editor, row, sectionType) {
  let line = editor.lineTextForBufferRow(row);
  let sectionMatch = line.match(/^[ \t]*(?:\\((?:sub){0,2}section|chapter|part|(?:sub)?paragraph)\s*\*?\s*(\[.*?\])?\{([^\}]*\})?)/);

  if (sectionMatch === null) {
    atom.notifications.addWarning("Cannot fold this section!", { dismissible: true });
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
    if(commentScopeSelector.matches(scopeArray)) { return; }

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
    atom.notifications.addWarning("Cannot fold this env!", { dismissible: true });
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
    if(commentScopeSelector.matches(scopeArray)) { return; }

    let type = match[1];
    if (type === "begin") { nestedCounter += 1; return; }

    if (nestedCounter > 0) { nestedCounter -= 1; return; }

    endDelimRange = range;
    matchFound = true;
    stop();
  });

  if (!matchFound) {
    atom.notifications.addWarning(`Closing delimiter for environment \`${ENV_NAME}\` not found`, { dismissible: true });
    return;
  }

  return new Range(startPoint, endDelimRange.start);
}

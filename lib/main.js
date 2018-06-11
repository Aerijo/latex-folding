const { CompositeDisposable } = require("atom");
const { ScopeSelector } = require("first-mate");
const { Point, Range } = require("atom");
const { $ } = require('atom-space-pen-views');

const CUSTOM_FOLD_CLASS = '.line-number.custom-latex-fold:not(.folded) .icon-right';

// Heavily drawn from `custom-folds`. The space-pen-views trick is especially weird, it seems to affect execution order of callbacks.

function toggleFold(ev, editor) {
  const { target, button } = ev;

  if (button !== 0) { return; }

  const clickedScreenPos = editor.component.screenPositionForMouseEvent(event);
  const clickedBufferPoint = editor.bufferPositionForScreenPosition(clickedScreenPos);
  const row = clickedBufferPoint.row;

  let sectionRange = getSectionRange(editor, clickedBufferPoint.translate([0,Infinity]), "section");
  // editor.foldBufferRange(sectionRange);     // not used because native folding then folds the rest if the end is indented
  editor.setSelectedBufferRange(sectionRange); // convoluted, but circumvents bug / glitch with native indentation folding
  editor.foldSelectedLines();
  editor.setSelectedBufferRanges(editor.folding.lastSelections, { preserveFolds: true });
}

function setMarkers(editor, sectionMarkers) {
  let gutter = editor.lineNumberGutter;

  sectionMarkers.map(marker => marker.destroy());
  sectionMarkers = [];

  editor.scan(/^[ \t]*\\((?:sub){0,2}section)(?=\b.*$)/g, ({ range, stop }) => {
    let marker = editor.markBufferRange(range, { invalidate: "touch" }); // touch invalidates the easiest, which should be fine
    sectionMarkers.push(marker);
    gutter.decorateMarker(marker, {
      type: "line-number",
      class: "custom-latex-fold"
    });
  });
}

function addFoldingRules(editor, mouseEnter, mouseDown) {
  if (editor.folding.foldingHooked) { console.warn("already hooked"); return; }
  editor.folding.foldingHooked = true;

  $(editor.lineNumberGutter.element).on('mousedown', CUSTOM_FOLD_CLASS, mouseDown);
  editor.lineNumberGutter.element.addEventListener("mouseenter", mouseEnter);


  editor.folding.sectionMarkers = [];
  let sectionMarkers = editor.folding.sectionMarkers;

  setMarkers(editor, sectionMarkers);
  editor.folding.foldingRules = editor.onDidStopChanging(
    () => { setMarkers(editor, sectionMarkers); }
  );

}

function removeFoldingRules(editor, mouseEnter, mouseDown) {
  if (editor.folding && editor.folding.foldingHooked === true) {
    editor.folding.foldingHooked = false;
    editor.folding.sectionMarkers.map(marker => marker.destroy());

    $(editor.lineNumberGutter.element).off('mousedown', CUSTOM_FOLD_CLASS, mouseDown);
    editor.lineNumberGutter.element.removeEventListener("mouseenter", mouseEnter);

    editor.folding.foldingRules.dispose();
  }
}

module.exports = {
  activate() {
    this.disposables = new CompositeDisposable();
    this.observedEditors = [];
    this.disposables.add(
      atom.workspace.observeTextEditors((editor) => {

        function mouseDown(ev) {
          return toggleFold(ev, editor);
        }

        function mouseEnter(ev) {
          // clicking our custom element deletes selections, so we remember them with this
          editor.folding.lastSelections = editor.getSelectedBufferRanges();
        }

        editor.observeGrammar((grammar) => {
          if (grammar.scopeName === "text.tex.latex") {
            editor.folding = {};
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


function getSectionRange(editor, startPoint, maxDepthString, startLevel = 1, includeSectionCommand = true, continueIfNoStart = true) {
  let levelTable = {
    "part": -1,
    "chapter": 0,
    "section": 1,
    "subsection": 2,
    "subsubsection": 3,
    "paragraph": 4,
    "subparagraph": 5
  };

  let maxDepth = levelTable[maxDepthString];

  let searchRegex = /^[ \t]*(?:\\((?:sub){0,2}section|chapter|part|(?:sub)?paragraph)\s*\*?\s*(\[.*?\])?\{([^\}]*\})?)|(?:\\end\s*\{\s*document\s*\})/g;
  let sectionRange = null;

  let sectionLevel = startLevel;

  let matchFound = false;
  let endSearchStartpoint = startPoint;
  let startSectionName = "";
  let notify = atom.notifications;

  if (!this.commentScopeSelector) {
    this.commentScopeSelector = new ScopeSelector("comment.*");
  }

  let sectionScanRange = new Range(endSearchStartpoint, editor.getBuffer().getEndPosition());
  matchFound = false;
  editor.scanInBufferRange(searchRegex, sectionScanRange, ({match, range, stop}) => {
    let command = match[1];

    if (sectionLevel < levelTable[command]) { return; }

    let scopeArray = editor.scopeDescriptorForBufferPosition(range.start).scopes;
    if(this.commentScopeSelector.matches(scopeArray)) { return; }

    endPoint = range.start;

    let line = editor.lineTextForBufferRow(range.end.row);
    let restOfLine = editor.getTextInBufferRange([range.end, [range.end.row, line.length]]);
    endSectionName = restOfLine.match(/^[^\}]*/)[0]; // the name of section where the counting ends

    matchFound = true;
    stop();
  });

  sectionRange = new Range(startPoint, endPoint.traverse([-1,Infinity]));
  return sectionRange;
}

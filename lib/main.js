const { CompositeDisposable } = require("atom");
const { ScopeSelector } = require("first-mate");
const { Point, Range } = require("atom");
const {$} = require('atom-space-pen-views');

// Heavily drawn from `custom-folds`. The space-pen-views trick is especially weird, it seems to affect execution order of callbacks.

function toggleFold(ev, editor, useCapture) {

  const { target, button } = ev;
  if (button !== 0) { return; }

  if (target.matches('.line-number.custom-latex-fold:not(.folded) .icon-right')) {
    console.log("caught one!");

    const clickedScreenPos = editor.component.screenPositionForMouseEvent(event);
    const clickedBufferPoint = editor.bufferPositionForScreenPosition(clickedScreenPos);
    const row = clickedBufferPoint.row;

    let sectionRange = getSectionRange(editor, clickedBufferPoint.translate([0,Infinity]), "section");
    editor.foldBufferRange(sectionRange);
    editor.getSelections().map(selection => selection.destroy());
  }

  // let foldable = target.matches(".foldable .icon-right") || target.matches(".folded .icon-right");
  // if (target && foldable) {
  //   const clickedScreenPos = editor.component.screenPositionForMouseEvent(event);
  //   const clickedBufferPoint = editor.bufferPositionForScreenPosition(clickedScreenPos);
  //   const startBufferRow = clickedBufferPoint.row;
  //
  //   let folded = target.matches(".foldable .icon-right");
  //
  //   if (editor.isFoldedAtBufferRow(startBufferRow)) return;
  //
  //   let nativeFold = editor.isFoldableAtBufferRow(startBufferRow);
  //
  //
  //   if (nativeFold) {
  //     return;
  //   } else {
  //     let sectionRange = getSectionRange(editor, clickedBufferPoint.translate([0,Infinity]), "section");
  //     editor.foldBufferRange(sectionRange);
  //   }
  // }
}

function setMarkers(editor, sectionMarkers) {
  console.log("setting markers");

  let gutter = editor.lineNumberGutter;

  sectionMarkers.map(marker => marker.destroy());

  editor.scan(/^[ \t]*\\((?:sub){0,2}section)(?=\b.*$)/g, ({ range, stop }) => {
    let marker = editor.markBufferRange(range, { invalidate: "inside" });
    sectionMarkers.push(marker);
    gutter.decorateMarker(marker, {
      type: "line-number",
      class: "custom-latex-fold"
    });
  });
}

function addFoldingRules(editor, mouseEnter, mouseUp, mouseDown, mouseDown2) {
  if (editor.folding.foldingHooked) { console.log("already hooked"); return; }
  console.log(`adding folding rules to ${editor.getTitle()}`);
  editor.folding.foldingHooked = true;

  // editor.lineNumberGutter.element.addEventListener("mouseenter", mouseEnter, false);
  // editor.lineNumberGutter.element.addEventListener("mouseup", mouseUp, false);
  // editor.lineNumberGutter.element.addEventListener("mousedown", mouseDown, true);
  // editor.lineNumberGutter.element.addEventListener("mousedown", mouseDown2, false);

  $(editor.lineNumberGutter.element).on('mousedown', '.line-number.custom-latex-fold:not(.folded) .icon-right', mouseDown);


  editor.folding.sectionMarkers = [];
  let sectionMarkers = editor.folding.sectionMarkers;

  setMarkers(editor, sectionMarkers);
  editor.folding.foldingRules = editor.onDidStopChanging(
    () => { setMarkers(editor, sectionMarkers); }
  );

}

function removeFoldingRules(editor, mouseEnter, mouseUp, mouseDown, mouseDown2) {
  if (editor.folding && editor.folding.foldingHooked === true) {
    console.log(`removing folding rules from ${editor.getTitle()}`);
    editor.folding.foldingHooked = false;
    editor.folding.sectionMarkers.map(marker => marker.destroy());
    editor.lineNumberGutter.element.removeEventListener("mouseenter", mouseEnter, false);
    editor.lineNumberGutter.element.removeEventListener("mouseup", mouseUp, false);
    editor.lineNumberGutter.element.removeEventListener("mousedown", mouseDown, true);
    editor.lineNumberGutter.element.removeEventListener("mousedown", mouseDown2, false);

    editor.folding.foldingRules.dispose();
  }
}

module.exports = {
  activate() {
    console.log("activated folding");
    this.disposables = new CompositeDisposable();
    this.observedEditors = [];
    this.disposables.add(
      atom.workspace.observeTextEditors((editor) => {

        function mouseDown(ev) {
          return toggleFold(ev, editor, true);
        }

        function mouseDown2(ev) {
          return toggleFold(ev, editor, false);
        }

        function mouseEnter(ev) {
          editor.folding.lastFoldsLayerLength = editor.displayLayer.foldsMarkerLayer.getMarkerCount();
          // console.log(editor.folding.lastFoldsLayerLength);
        }

        function mouseUp(ev) {
          editor.folding.lastFoldsLayerLength = editor.displayLayer.foldsMarkerLayer.getMarkerCount();
          // console.log(editor.folding.lastFoldsLayerLength);
        }

        editor.observeGrammar((grammar) => {
          if (grammar.scopeName === "text.tex.latex") {
            editor.folding = {};
            addFoldingRules(editor, mouseEnter, mouseUp, mouseDown, mouseDown2);
          } else {
            removeFoldingRules(editor, mouseEnter, mouseUp, mouseDown, mouseDown2);
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
  /*
    Gets the text at the current level of the cursor. E.g.,
    \section{Section 1}
    $1
      \subsection{Subsection 1}
      $2
      \subsection{Subsection 2}
      $3

    $1 will get all text within the section and subsections
    $2 will get all text in Subsection 1
    $3 will get all text in Subsection 2 (and any following subsubsection's or lower)

    maxDepth determines what is a valid section label. The smaller it is, the
    more restrictive the set of section commands that will be recognised.

    Section levels are from https://en.wikibooks.org/wiki/LaTeX/Document_Structure#Sectioning_commands
  */

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

  let searchRegex = /(?:\\((?:sub)?section|chapter|part|(?:sub)?paragraph)\s*\*?\s*(\[.*?\])?\{([^\}]*\})?)|(?:\\end\s*\{\s*document\s*\})/g;
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

const { CompositeDisposable } = require("atom");


function toggleFold(ev, editor) {
  const { target, button } = ev;
  if (button !== 0) { return; }
  // return;
  let foldable = target.matches(".foldable .icon-right") || target.matches(".folded .icon-right");
  if (target && foldable) {
    // console.log("TOGGLE FOLDING");
    const clickedScreenPos = editor.component.screenPositionForMouseEvent(event);
    const startBufferRow = editor.bufferPositionForScreenPosition(clickedScreenPos).row;
    //
    let folded = target.matches(".foldable .icon-right");

    // console.log(editor.displayLayer.foldsMarkerLayer.getMarkers().map(marker => marker.getRange()));
    // console.log(editor.folding.lastFoldsLayerLength);
    // console.log(editor.isFoldedAtBufferRow(startBufferRow));

    if (editor.isFoldedAtBufferRow(startBufferRow)) return; // it means the user is unfolding, so handled natively

    let nativeFold = editor.isFoldableAtBufferRow(startBufferRow);


    if (nativeFold) {
      console.log("native folding");
    } else {
      console.log("custom folding");
    }
  }
}

function setMarkers(editor, sectionMarkers) {
  console.log("setting markers");

  let gutter = editor.lineNumberGutter;

  sectionMarkers.map(marker => marker.destroy());

  editor.scan(/^[ \t]*\\((?:sub){0,2}section|begin)(?=\b.*$)/g, ({ range, stop }) => {
    let marker = editor.markBufferRange(range, { invalidate: "inside" });
    sectionMarkers.push(marker);
    gutter.decorateMarker(marker, {
      type: "line-number",
      class: "foldable"
    });
  });
}

function addFoldingRules(editor, mouseEnter, mouseUp, mouseDown) {
  if (editor.folding.foldingHooked) { console.log("already hooked"); return; }
  console.log(`adding folding rules to ${editor.getTitle()}`);
  editor.folding.foldingHooked = true;

  editor.lineNumberGutter.element.addEventListener("mouseenter", mouseEnter, true);
  editor.lineNumberGutter.element.addEventListener("mouseup", mouseUp, true);
  editor.lineNumberGutter.element.addEventListener("mousedown", mouseDown, true);

  editor.folding.sectionMarkers = [];
  let sectionMarkers = editor.folding.sectionMarkers;

  setMarkers(editor, sectionMarkers);
  editor.folding.foldingRules = editor.onDidStopChanging(
    () => { setMarkers(editor, sectionMarkers); }
  );

}

function removeFoldingRules(editor, mouseEnter, mouseUp, mouseDown) {
  if (editor.folding && editor.folding.foldingHooked === true) {
    console.log(`removing folding rules from ${editor.getTitle()}`);
    editor.folding.foldingHooked = false;
    editor.folding.sectionMarkers.map(marker => marker.destroy());
    editor.lineNumberGutter.element.removeEventListener("mouseenter", mouseEnter, true);
    editor.lineNumberGutter.element.removeEventListener("mouseup", mouseUp, true);
    editor.lineNumberGutter.element.removeEventListener("mousedown", mouseDown, true);

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
          return toggleFold(ev, editor);
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
            addFoldingRules(editor, mouseEnter, mouseUp, mouseDown);
          } else {
            removeFoldingRules(editor, mouseEnter, mouseUp, mouseDown);
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

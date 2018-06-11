const { CompositeDisposable } = require("atom");

function toggleFold(ev, editor) {
  const { target, button } = ev;
  if (button !== 0) { return; }

  let foldable = target.matches('.foldable .icon-right') || target.matches('.folded .icon-right');
  if (target && foldable) {
    console.log("TOGGLE FOLDING");
  }
}

function setMarkers(editor, sectionMarkers) {
  console.log("setting markers");

  let gutter = editor.gutterWithName("line-number");

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

function addFoldingRules(editor, callback) {
  if (editor.folding.foldingHooked) { console.log("already hooked"); return; }
  console.log(`adding folding rules to ${editor.getTitle()}`);
  editor.folding.foldingHooked = true;

  editor.lineNumberGutter.element.addEventListener("click", callback);

  editor.folding.sectionMarkers = [];
  let sectionMarkers = editor.folding.sectionMarkers;

  setMarkers(editor, sectionMarkers);
  editor.folding.foldingRules = editor.onDidStopChanging(
    () => { setMarkers(editor, sectionMarkers); }
  );

}

function removeFoldingRules(editor, callback) {
  if (editor.folding && editor.folding.foldingHooked === true) {
    console.log("removing folding hooks");
    editor.folding.foldingHooked = false;
    editor.folding.sectionMarkers.map(marker => marker.destroy());
    editor.lineNumberGutter.element.removeEventListener("click", callback );
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

        function callback(ev) {
          return toggleFold(ev, editor);
        }

        editor.observeGrammar((grammar) => {
          if (grammar.scopeName === "text.tex.latex") {
            editor.folding = {};
            addFoldingRules(editor, callback);
          } else {
            removeFoldingRules(editor, callback);
          }
        })
      })
    );
  },

  deactivate() {
    if (this.disposables) {
      this.disposables.dispose();
    }
  }
}

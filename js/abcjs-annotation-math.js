(function () {
  'use strict';

  // Shared palette for notes (@r:C) and annotations ("^@r:Text").
  // Edit or add aliases here.
  const NOTE_COLOR_ALIASES = {
    r: '#DE7070',
    g: '#32A466',
    b: '#5085DC',
    y: '#DFC95F',
  };

  const svgNS = 'http://www.w3.org/2000/svg';
  const DEFAULT_ANNOTATION_LINE_HEIGHT = 1.25;
  let EngraverController;

  function getEngraverController() {
    if (EngraverController) return EngraverController;
    // The controller is exposed on renderAbc's result rather than exported.
    // Render a small probe once to get its constructor without patching ABCJS.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;';
    document.body.appendChild(probe);
    try {
      const visual = ABCJS.renderAbc(probe, 'X:1\nK:C\nC')[0];
      EngraverController = visual.engraver.constructor;
      return EngraverController;
    } finally {
      probe.remove();
    }
  }

  function attach(controller, math) {
    const paper = controller.renderer.paper;
    const annotationAttributes = new WeakMap();
    const originalText = paper.text;
    const originalSetup = controller.setupTune;
    const originalConstruct = controller.constructTuneElements;

    paper.text = function (text, attr, target) {
      const annotation = annotationAttributes.get(attr);
      if (!target && annotation && attr['data-name'] === 'annotation') {
        return math.draw(this, text, attr, annotation);
      }
      return originalText.call(this, text, attr, target);
    };

    controller.setupTune = function (...args) {
      // engraveABC creates a new text measurer before each tune. Adapt that
      // instance before setupTune creates the native abstract engraver.
      const textSize = this.getTextSize;
      const originalAttr = textSize.attr;
      const originalCalc = textSize.calc;
      textSize.attr = function (type, klass) {
        const hash = originalAttr.call(this, type, klass);
        if (type === 'annotationfont') {
          // Native lane spacing uses font.size; SVG text still uses the actual
          // font-size attribute. This reserves enough room for tall formulas.
          hash.font.size = math.laneHeight(paper, hash.attr);
        }
        return hash;
      };
      textSize.calc = function (text, type, klass, el) {
        if (type !== 'annotationfont') return originalCalc.call(this, text, type, klass, el);
        const hash = this.attr(type, klass);
        const size = math.measure(paper, text, hash.attr);
        const padding = hash.font.box ? hash.font.padding * 4 : 0;
        return { width: size.width + padding, height: size.height + padding };
      };
      return originalSetup.apply(this, args);
    };

    controller.constructTuneElements = function (tune) {
      const result = originalConstruct.call(this, tune);
      // ABCJS has already interpreted the prefixes and set centerVertically.
      // Keep that information with each annotation's native attribute object.
      tune.lines.forEach(line => {
        if (!line.staffGroup) return;
        line.staffGroup.voices.forEach(voice => {
          voice.children.forEach(element => {
            element.children.forEach(relative => {
              if (relative.type !== 'text' || !relative.dim) return;
              annotationAttributes.set(relative.dim.attr, {
                centerVertically: relative.centerVertically,
                lineHeight: relative.dim.font.size,
              });
            });
          });
        });
      });
      return result;
    };
  }

  function resolveColor(name) {
    const color = NOTE_COLOR_ALIASES[name] || name;
    return name && CSS.supports('color', color) ? color : null;
  }

  function prepareColors(source) {
    const colors = new Map();
    let annotationColors = false;
    let offset = 0;
    const abc = source.replace(/\r\n?/g, '\n').split('\n').map(line => {
      let result = '';
      let start = 0;
      let inChord = false;
      if (!/^\s*(?:[A-Za-z]:|%|\\)/.test(line)) {
        // Protect comments, native decorations, inline fields, and grace notes.
        const tokens = /"[^"\n]*"|%.*|\[[A-Za-z]:[^\]]*\]|\{[^}]*\}|![^!\n]*!|\+[^+\n]*\+|@([^\s:"]+):([ \t]*)([_^=]*(?:\d*\/\d*)?[A-Ga-g][,']*)|\[(?=[ \t]*[@!_^=A-Ga-g])|\]|[ \t]+/g;
        for (const match of line.matchAll(tokens)) {
          result += line.slice(start, match.index);
          let text = match[0];
          const color = resolveColor(match[1]);
          if (color) {
            text = (inChord ? '' : match[2]) + match[3];
            colors.set(offset + result.length + text.length - match[3].length, color);
          } else if (text.startsWith('"')) {
            // Keep the marker in the parsed annotation until afterParsing.
            // Repeat it on each row before ABCJS merges stacked annotations.
            const annotation = text.match(/^"(?:[_^<>]|@[-+\d.]+,[-+\d.]+[ \t]*)(@([^\s:"]+):)/);
            if (annotation && resolveColor(annotation[2])) {
              annotationColors = true;
              text = text.replace(/\\n|;/g, separator => separator + annotation[1]);
            }
          } else if (text === '[') inChord = true;
          else if (text === ']') inChord = false;
          else if (inChord && /^[ \t]+$/.test(text)) text = '';
          result += text;
          start = match.index + match[0].length;
        }
      }
      result += line.slice(start);
      offset += result.length + 1;
      return result;
    }).join('\n');
    const hasColors = colors.size > 0 || annotationColors;
    return { abc: hasColors ? abc : source, colors, hasColors };
  }

  function markColors(tune, abc, colors) {
    tune.lines.forEach(line => (line.staff || []).forEach(staff => staff.voices.forEach(voice => {
      voice.forEach(note => {
        (note.chord || []).forEach(chord => {
          if (chord.position === 'default') return;
          chord.colorRows = chord.name.split('\n').map(text => {
            const marker = text.match(/^@([^\s:]+):/);
            const color = marker && resolveColor(marker[1]);
            return { text: color ? text.slice(marker[0].length) : text, color };
          });
          // Strip before measuring so prefixes take no space in the score.
          chord.name = chord.colorRows.map(row => row.text).join('\n');
        });
        if (!note.pitches) return;
        const source = abc.slice(note.startChar, note.endChar);
        const tokens = /"[^"]*"|%[^\n]*|\{[^}]*\}|\[[A-Za-z]:[^\]]*\]|![^!]*!|\+[^+]*\+|([_^=]*(?:\d*\/\d*)?[A-Ga-g][,']*)/g;
        let index = 0;
        for (const match of source.matchAll(tokens)) {
          if (!match[1]) continue;
          const pitch = note.pitches[index++];
          const color = colors.get(note.startChar + match.index);
          if (pitch && color) pitch.noteColor = color;
        }
      });
    })));
  }

  function drawColors(tune) {
    tune.engraver.staffgroups.forEach(group => group.voices.forEach(voice => voice.children.forEach(element => {
      const rows = (element.abcelem.chord || []).flatMap(chord =>
        (chord.colorRows || []).slice().reverse().map(row => ({ ...row,
          position: chord.rel_position ? 'relative' : chord.position })));
      element.children.forEach(child => {
        if (child.type !== 'text') return;
        const index = rows.findIndex(row => row.text === child.c && row.position === child.position);
        if (index < 0) return;
        const { color } = rows.splice(index, 1)[0];
        if (color && child.graphelem) {
          child.graphelem.style.fill = color;
          // MathJax paths use currentColor rather than inherited fill.
          child.graphelem.style.color = color;
        }
      });
      (element.abcelem.pitches || []).forEach((pitch, index) => {
        if (!pitch.noteColor) return;
        const head = element.heads[index];
        if (!head) return;
        const accidental = element.children.find(child => child.c && child.c.startsWith('accidentals.') &&
          child.pitch === head.pitch && child.chordPos === head.chordPos);
        [head, accidental].forEach(child => {
          if (child && child.graphelem) child.graphelem.style.fill = pitch.noteColor;
        });
      });
    })));
  }

  function renderAbc(output, abc, options = {}, formulas = {}) {
    const prepared = prepareColors(abc);
    abc = prepared.abc;
    if (prepared.hasColors) {
      const afterParsing = options.afterParsing;
      options = { ...options, afterParsing(tune, ...args) {
        markColors(tune, abc, prepared.colors);
        if (afterParsing) afterParsing(tune, ...args);
      } };
    }
    const math = create(formulas, options.annotationLineHeight);
    const visuals = render(output, abc, options, math);
    if (prepared.hasColors) visuals.forEach(drawColors);
    return visuals;
  }

  function render(output, abc, options, math) {
    if (!math) return ABCJS.renderAbc(output, abc, options);
    const Controller = getEngraverController();
    // Use the library's parsing engine and native engraving on isolated
    // controller instances. Neither ABCJS nor its prototypes are modified.
    return ABCJS.renderEngine((target, tune, tuneNumber, abcString) => {
      if (options.afterParsing) options.afterParsing(tune, tuneNumber, abcString);
      target.textContent = '';
      const controller = new Controller(target, options);
      attach(controller, math);
      controller.engraveABC(tune, tuneNumber, 0);
      tune.engraver = controller;
    }, output, abc, options);
  }

  function create(formulas, annotationLineHeight) {
    const tokens = Object.keys(formulas);
    if (!tokens.length && annotationLineHeight === undefined) return null;
    const lineHeight = annotationLineHeight === undefined
      ? DEFAULT_ANNOTATION_LINE_HEIGHT : annotationLineHeight;
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
      throw new RangeError('annotationLineHeight must be a positive number');
    }
    const pattern = tokens.length ? new RegExp(`(${tokens.join('|')})`, 'g') : null;
    const templates = new Map();
    const metricCache = new Map();

    tokens.forEach(token => {
      const doc = new DOMParser().parseFromString(formulas[token].svg, 'image/svg+xml');
      templates.set(token, doc.documentElement);
    });

    function fontMetrics(paper, attr) {
      const fontSize = Number(attr['font-size']) || 16;
      const sample = paper.text('Mg', { ...attr, x: 0, y: 0 });
      const box = sample.getBBox();
      sample.remove();
      let ascent = Math.max(fontSize * 0.8, -box.y);
      let descent = Math.max(fontSize * 0.2, box.y + box.height);
      tokens.forEach(token => {
        const [, y, , height] = formulas[token].viewBox;
        ascent = Math.max(ascent, -y / 1000 * fontSize);
        descent = Math.max(descent, (y + height) / 1000 * fontSize);
      });
      return { fontSize, ascent, height: ascent + descent };
    }

    function layout(paper, text, attr) {
      const fontAttr = { ...attr };
      delete fontAttr.x;
      delete fontAttr.y;
      delete fontAttr['text-anchor'];
      const key = text + JSON.stringify(fontAttr);
      if (metricCache.has(key)) return metricCache.get(key);
      const metrics = fontMetrics(paper, fontAttr);
      let width = 0;
      const runs = (pattern ? text.split(pattern) : [text]).filter(Boolean).map(part => {
        const formula = formulas[part];
        let runWidth;
        if (formula) {
          runWidth = formula.viewBox[2] / 1000 * metrics.fontSize;
        } else {
          const el = paper.text(part, { ...fontAttr, x: 0, y: 0, 'xml:space': 'preserve' });
          // getComputedTextLength includes the spaces around inline math.
          runWidth = el.getComputedTextLength();
          el.remove();
        }
        const run = { part, formula, x: width, width: runWidth };
        width += runWidth;
        return run;
      });
      const result = { ...metrics, width, runs };
      metricCache.set(key, result);
      return result;
    }

    return {
      measure(paper, text, attr) {
        const metrics = layout(paper, String(text), attr);
        return { width: metrics.width, height: metrics.height };
      },
      laneHeight(paper, attr) {
        // ABCJS multiplies this size by 1.25 when drawing successive lanes.
        // Compensate here so the requested multiplier controls the row step
        // without changing glyph sizes or the native annotation order.
        return fontMetrics(paper, attr).height * lineHeight / 1.25;
      },
      draw(paper, text, attr, params) {
        const metrics = layout(paper, text, attr);
        const group = document.createElementNS(svgNS, 'g');
        Object.keys(attr).forEach(key => {
          if (!['x', 'y', 'text-anchor', 'dominant-baseline'].includes(key)) group.setAttribute(key, attr[key]);
        });
        let x = Number(attr.x);
        if (attr['text-anchor'] === 'middle') x -= metrics.width / 2;
        if (attr['text-anchor'] === 'end') x -= metrics.width;
        const top = Number(attr.y) - (params.centerVertically ? metrics.height / 2 : params.lineHeight);
        const baseline = top + metrics.ascent;
        group.setAttribute('aria-label', metrics.runs.map(run => run.formula ? run.formula.tex : run.part).join(''));
        metrics.runs.forEach(run => {
          if (run.formula) {
            const svg = templates.get(run.part).cloneNode(true);
            const [, y, , height] = run.formula.viewBox;
            svg.removeAttribute('style');
            svg.setAttribute('x', x + run.x);
            svg.setAttribute('y', baseline + y / 1000 * metrics.fontSize);
            svg.setAttribute('width', run.width);
            svg.setAttribute('height', height / 1000 * metrics.fontSize);
            svg.setAttribute('class', 'abcjs-annotation-math');
            svg.setAttribute('aria-hidden', 'true');
            group.appendChild(svg);
          } else {
            paper.text(run.part, {
              x: x + run.x, y: baseline, 'text-anchor': 'start',
              'xml:space': 'preserve',
            }, group);
          }
        });
        paper.append(group);
        return group;
      },
    };
  }

  window.AbcjsAnnotationMath = { renderAbc };
})();

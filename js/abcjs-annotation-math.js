(function () {
  'use strict';

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

  function renderAbc(output, abc, options = {}, formulas = {}) {
    const math = create(formulas, options.annotationLineHeight);
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

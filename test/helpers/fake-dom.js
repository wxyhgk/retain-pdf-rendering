"use strict";

// Minimal, dependency-free DOM used by the render golden tests. It models
// only what the renderer touches: elements, fragments, class lists, dataset,
// inline styles (including custom properties) and raw innerHTML strings.
// Serialization is deterministic so two renderer implementations can be
// compared byte for byte.

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const cssName = name => name.startsWith("--") ? name : name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const dataName = name => `data-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;

class FakeNode {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }

  appendChild(child) {
    if (child instanceof FakeFragment) {
      for (const node of [...child.childNodes]) this.appendChild(node);
      child.childNodes = [];
      return child;
    }
    if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(node => node !== child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(typeof child === "string" ? new FakeText(child) : child);
  }

  replaceChildren(...children) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...children);
  }

  get children() {
    return this.childNodes.filter(node => node instanceof FakeElement);
  }

  get textContent() {
    return this.childNodes.map(node => node.textContent).join("");
  }

  set textContent(value) {
    this.replaceChildren(new FakeText(String(value ?? "")));
  }

  get innerHTML() {
    return this.childNodes.map(node => node.serialize()).join("");
  }

  set innerHTML(value) {
    this.replaceChildren(new FakeRawHTML(String(value ?? "")));
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.text = text;
  }

  get textContent() { return this.text; }

  serialize() { return escapeText(this.text); }
}

// Markup assigned through innerHTML is kept verbatim; the renderer's HTML is
// produced by injected (stubbed) markdown/TeX renderers in these tests.
class FakeRawHTML extends FakeNode {
  constructor(html) {
    super();
    this.html = html;
  }

  get textContent() { return this.html.replace(/<[^>]*>/g, ""); }

  serialize() { return this.html; }
}

class FakeFragment extends FakeNode {
  serialize() { return this.innerHTML; }
}

function createStyle(element) {
  const values = new Map();
  const target = {
    setProperty(name, value) {
      element.touchAttribute("style");
      values.set(cssName(name), String(value));
    },
    getPropertyValue(name) {
      return values.get(cssName(name)) || "";
    },
    toString() {
      return [...values].map(([name, value]) => `${name}: ${value};`).join(" ");
    }
  };
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property];
      if (typeof property !== "string") return undefined;
      return values.get(cssName(property)) || "";
    },
    set(object, property, value) {
      element.touchAttribute("style");
      const name = cssName(String(property));
      if (value === "" || value === null || value === undefined) values.delete(name);
      else values.set(name, String(value));
      return true;
    }
  });
}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.attributeOrder = [];
    this.attributes = new Map();
    this.style = createStyle(this);
    const element = this;
    this.dataset = new Proxy({}, {
      get(_, property) {
        if (typeof property !== "string") return undefined;
        return element.attributes.has(dataName(property)) ? element.attributes.get(dataName(property)) : undefined;
      },
      set(_, property, value) {
        element.setAttribute(dataName(String(property)), String(value));
        return true;
      },
      deleteProperty(_, property) {
        element.removeAttribute(dataName(String(property)));
        return true;
      }
    });
    this.classList = {
      add(...names) {
        const current = element.className ? element.className.split(/\s+/) : [];
        for (const name of names) if (!current.includes(name)) current.push(name);
        element.className = current.join(" ");
      },
      remove(...names) {
        element.className = (element.className ? element.className.split(/\s+/) : [])
          .filter(name => !names.includes(name)).join(" ");
      },
      contains(name) {
        return (element.className ? element.className.split(/\s+/) : []).includes(name);
      }
    };
  }

  touchAttribute(name) {
    if (!this.attributeOrder.includes(name)) this.attributeOrder.push(name);
  }

  setAttribute(name, value) {
    this.touchAttribute(name);
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    if (name === "style") return String(this.style) || null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    this.attributeOrder = this.attributeOrder.filter(item => item !== name);
  }

  get className() { return this.attributes.get("class") || ""; }

  set className(value) { this.setAttribute("class", value); }

  closest() { return null; }

  serialize() {
    const tag = this.tagName.toLowerCase();
    const attributes = this.attributeOrder.map(name => {
      const value = name === "style" ? String(this.style) : this.attributes.get(name);
      return ` ${name}="${escapeAttribute(value)}"`;
    }).join("");
    return `<${tag}${attributes}>${this.innerHTML}</${tag}>`;
  }

  get outerHTML() { return this.serialize(); }
}

function createFakeDocument() {
  return {
    createElement: tagName => new FakeElement(tagName),
    createDocumentFragment: () => new FakeFragment(),
    createTextNode: text => new FakeText(String(text))
  };
}

function serialize(node) {
  return node.serialize();
}

module.exports = { createFakeDocument, serialize };

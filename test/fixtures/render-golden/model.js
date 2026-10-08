"use strict";

// Small synthetic layout model covering every node type the renderer emits.
module.exports = {
  styles: {},
  pages: [
    {
      index: 0,
      width: 612,
      height: 792,
      blocks: [
        { id: "p0-title", type: "title", translatable: true, translatedText: "标题" },
        { id: "p0-body-1", type: "text", translatable: true, translatedText: "正文" }
      ],
      restoration: {
        ocrBoxes: [],
        streams: [
          {
            bbox: [54, 120, 300, 700],
            debugRole: "text",
            styleKind: "body_text",
            bodyInherited: true,
            columnKey: "p0-left",
            fontSize: 9.2,
            lineHeight: 1.2,
            paragraphGap: 0.2,
            items: [
              {
                id: "p0-body-1",
                originalLineCount: 6,
                debugLines: [[54, 120, 300, 131], [54, 132, 300, 143]],
                paragraphs: [
                  {
                    indent: 12,
                    parts: [
                      { id: "p0-body-1a", text: "Energy is con-", html: "<b>Energy</b> is con-", translatedText: "能量守恒，且 \\sigma _ { t } 随时间变化。", originalLineCount: 3 },
                      { id: "p0-body-1b", text: "served across frames.", translatedText: "", originalLineCount: 3 }
                    ]
                  },
                  {
                    indent: 0,
                    parts: [
                      { id: "p0-body-1c", text: "See ![fig](images/image_1.png) for details.", translatedText: "详见图\u0008示 \\\\(x\\\\)。" }
                    ]
                  }
                ]
              }
            ]
          },
          {
            bbox: [312, 120, 558, 700],
            debugRole: "text",
            styleKind: "body_text",
            bodyInherited: false,
            columnKey: "p0-right",
            equationDense: true,
            items: [
              { id: "p0-list-1", fromList: true, text: "• first item", translatedText: "• 第一项", originalLineCount: 1, indent: 4 },
              { id: "p0-list-2", text: "• second item", translatedText: "• 第二项", parts: [{ id: "p0-list-2a", text: "• second item", translatedText: "• 第二项", fromList: true, debugLines: [[312, 140, 400, 150]] }] }
            ]
          },
          {
            bbox: [200, 300, 412, 312],
            debugRole: "text",
            styleKind: "text",
            columnKey: "",
            items: [{ id: "p0-centered", text: "A centered single line", translatedText: "居中单行", originalLineCount: 1 }]
          },
          {
            bbox: [54, 710, 558, 770],
            debugRole: "ref_text",
            styleKind: "reference",
            refsOnly: true,
            fontSize: 7.4,
            lineHeight: 1.1,
            items: [
              { id: "p0-ref-1", kind: "ref_text", text: "[1] A. Author. Title. 2020.", originalLineCount: 1 },
              { id: "p0-ref-2", kind: "ref_text", text: "[2] B. Author. Another. 2021.", translatedText: "[2] B. Author. 另一篇. 2021.", originalLineCount: 2 }
            ]
          }
        ],
        absoluteBlocks: [
          { id: "p0-title", type: "title", kind: "text", mainTitle: true, bbox: [80, 40, 532, 80], fontSize: 18, lineHeight: 1.1, lineCount: 2, text: "A Synthetic Paper", translatedText: "合成论文", debugLines: [[80, 40, 532, 60]] },
          { id: "p0-header", type: "header", kind: "text", sourceOnly: true, bbox: [54, 12, 558, 24], fontSize: 7, text: "Journal header", sourceHTML: "<span class=\"src\">Journal header</span>" },
          { id: "p0-footer", type: "footer", kind: "text", sourceOnly: true, bbox: [290, 776, 322, 786], fontSize: 7, text: "1" },
          { id: "p0-formula", type: "interline_equation", kind: "formula", bbox: [100, 330, 500, 360], numberRight: 548.5, formulas: ["\\[ E = mc^2 \\tag{3} \\]"], formulaItems: [{ id: "p0-formula-item" }] },
          { id: "p0-formula-plain", type: "interline_equation", kind: "formula", bbox: [100, 365, 500, 380], text: "$$a<b & c$$" },
          { id: "p0-figure", type: "image", kind: "image", bbox: [100, 390, 500, 560], imageURL: "resource://doc/images/a\"b.png" },
          { id: "p0-caption", type: "image_caption", kind: "text", bbox: [100, 562, 500, 580], fontSize: 8, lineCount: 2, text: "Figure 1: A figure.", translatedText: "图 1：一幅图。" },
          { id: "p0-table", type: "table", kind: "table", bbox: [100, 582, 500, 640], tableHTML: "<table><tr><td>1</td></tr></table>" },
          { id: "p0-code", type: "code", kind: "code", codeLanguage: "python", bbox: [100, 642, 500, 690], lineHeight: 1.05, text: "if a < b:\n    print(\"x\")" },
          { id: "p0-text-single", type: "text", kind: "text", bbox: [150, 692, 462, 702], fontSize: 8, lineCount: 1, text: "Symmetric line", translatedText: "" },
          { id: "p0-footnote", type: "page_footnote", kind: "text", bbox: [54, 703, 300, 709], fontSize: 6.5, text: "1 Footnote." }
        ]
      }
    },
    {
      index: 1,
      width: 595,
      height: 842,
      blocks: [
        { id: "p1-heading", type: "title", kind: "text", translatable: true, bbox: [60, 60, 300, 80], fontSize: 12, text: "Contents", translatedText: "目录" },
        { id: "p1-text", type: "text", kind: "text", translatable: true, bbox: [60, 90, 535, 200], fontSize: 9, lineCount: 4, text: "Fallback block without restoration.", translatedText: "" },
        { id: "p1-weird", type: "table caption!", bbox: [60, 210, 535, 220], text: "Odd type" }
      ],
      restoration: {
        streams: [
          {
            bbox: [60, 230, 535, 400],
            debugRole: "toc entry",
            styleKind: "toc",
            items: [
              {
                id: "p1-toc",
                tocRows: [
                  { number: "1", title: "Introduction", page: "1", level: 0 },
                  { gap: true },
                  { number: "1.1", title: "Motivation <and> scope", page: "2", level: 1 },
                  { text: "Unparsed & line" }
                ],
                translatedText: "1 引言 1\n\n1.1 动机与范围 2\n未解析的行"
              }
            ]
          }
        ],
        absoluteBlocks: []
      }
    },
    {
      index: 2,
      width: 612,
      height: 792,
      blocks: [
        { id: "p2-a", type: "text", kind: "text", translatable: true, bbox: [60, 60, 550, 120], fontSize: 9, text: "Untranslated page body." },
        { id: "p2-ref", type: "ref_text", kind: "ref_text", bbox: [60, 130, 550, 140], text: "[3] Ref." }
      ]
    },
    {
      index: 3,
      width: 612,
      height: 792,
      blocks: [
        { id: "p3-ref", type: "ref_text", kind: "ref_text", bbox: [60, 130, 550, 140], fontSize: 7.5, text: "[4] Reference-only page." },
        { id: "p3-plain", type: "text", kind: "text", bbox: [60, 150, 550, 170], fontSize: 8, lineCount: 2, text: "Plain fallback block." }
      ]
    }
  ]
};

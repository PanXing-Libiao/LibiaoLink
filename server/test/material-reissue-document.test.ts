import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import type { MaterialReissueSnapshot } from "@libiaolink/contracts";
import { buildMaterialReissueDocx, materialReissueFileName } from "../src/modules/file/material-reissue-document.js";

const AT = new Date("2026-11-09T04:05:00.000Z");
const SNAPSHOT: MaterialReissueSnapshot = {
  reason: "transport_damage",
  applicationDepartment: "after_sales",
  accepted: true,
  inWarranty: false,
  freeReissue: true,
  approved: "no",
  responsibleDepartment: "supplier",
  requiredOutDate: "2026-11-12",
  oldPartReturn: true,
  freightBearer: "libiao",
  recipient: "张三",
  phone: "13800000000",
  address: "广州市黄埔区测试路 1 号\n第二行地址",
  description: "运输过程中外壳破损，需要补发替换。",
  materials: [
    { materialCode: "M-001", materialName: "光电传感器", specification: "E3Z-D61", quantity: 2, unit: "个", remark: "随主机补发" },
    { materialCode: "", materialName: "安装支架", specification: "不锈钢", quantity: 1.5, unit: "套", remark: "含螺丝" },
  ],
  taskId: "44444444-4444-4444-8444-444444444444",
  taskTitle: "分拣线安装",
  projectCode: "LBGN23171-G1",
  projectName: "虹迪广州NIKE分拣改造项目 & 现场改造",
  customerName: "NIKE",
  applicantName: "李四",
};

function cellTexts(rowXml: string): string[] {
  return [...rowXml.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((cell) => {
    const text = [...cell[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:sym\b[^>]*w:char="([0-9A-Fa-f]+)"[^>]*\/>/g)]
      .map((match) => (match[2] === undefined ? match[1] : match[2] === "0052" ? "☑" : "☐"))
      .join("");
    return text.replace(/&amp;/g, "&");
  });
}

describe("物料变更补发 DOCX", () => {
  it("按原《补发/补货申请表》模板生成单页 DOCX，文件名按上海时区", async () => {
    expect(materialReissueFileName(SNAPSHOT, AT)).toBe("补发申请-LBGN23171-G1-202611091205.docx");

    const bytes = buildMaterialReissueDocx(SNAPSHOT, AT);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((name) => !name.endsWith("/")).sort();
    expect(names).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/app.xml",
      "docProps/core.xml",
      "docProps/custom.xml",
      "word/_rels/document.xml.rels",
      "word/_rels/header1.xml.rels",
      "word/document.xml",
      "word/fontTable.xml",
      "word/footer1.xml",
      "word/header1.xml",
      "word/media/image1.png",
      "word/numbering.xml",
      "word/settings.xml",
      "word/styles.xml",
      "word/theme/theme1.xml",
    ]);

    const documentXml = await zip.file("word/document.xml")!.async("string");
    const headerXml = await zip.file("word/header1.xml")!.async("string");
    const footerXml = await zip.file("word/footer1.xml")!.async("string");
    const coreXml = await zip.file("docProps/core.xml")!.async("string");
    const image = await zip.file("word/media/image1.png")!.async("nodebuffer");

    expect(documentXml).toContain("补发/补货申请表");
    expect(documentXml).toContain("邮件标题：");
    expect(documentXml).toContain("【补发申请】");
    expect(documentXml).toContain("  项目");
    expect(documentXml).toContain("LBGN23171-G1 虹迪广州NIKE分拣改造项目 &amp; 现场改造项目");
    expect(documentXml).toContain("/ 紧急");
    expect(documentXml).not.toContain("来源任务");
    expect(documentXml).not.toContain("申请时间");
    expect(documentXml).not.toContain("提交时间");
    expect(documentXml).not.toContain("提交人");
    expect(documentXml).toContain("2026/11/12");
    expect(documentXml).not.toContain("2026-11-12");
    expect(documentXml).toContain("Wingdings 2");
    expect(documentXml).toContain('w:char="0052"');
    expect(documentXml).toContain('w:char="00A3"');
    expect(documentXml).toContain("第二行地址");
    expect(documentXml).toContain("<w:br/>");
    expect(documentXml).toContain("须先经夏总审批");
    expect(documentXml).toContain("收货信息、出库时间、运费承担方式需填写完整后再提交。");
    expect(documentXml).toContain("w:numId w:val=\"1\"");
    expect(documentXml).toContain('w:pgSz w:w="11906" w:h="16838"');
    expect(documentXml).toContain('w:top="1304" w:right="1077" w:bottom="1304" w:left="1077"');
    expect(documentXml).toContain('w:tblW w:w="9968" w:type="dxa"');
    expect(documentXml).toContain('w:tblW w:w="9962" w:type="dxa"');

    const tables = [...documentXml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((match) => match[0]);
    expect(tables).toHaveLength(2);
    const mainRows = [...tables[0]!.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((match) => cellTexts(match[0]));
    expect(mainRows.map((row) => row[0])).toEqual([
      "项目",
      "项目编号",
      "项目名称",
      "客户名称",
      "申请部门",
      "申请人",
      "补发类别",
      "是否已验收",
      "是否质保期内",
      "是否免费补发",
      "是否已审批",
      "责任归属部门",
      "要求出库时间",
      "是否涉及旧件返还",
      "运费承担",
      "收货人",
      "联系电话",
      "收货地址",
      "补发原因简述",
    ]);
    expect(mainRows[4]![1]).toContain("☐ 项目部");
    expect(mainRows[4]![1]).toContain("☑ 售后部");
    expect(mainRows[4]![1]).toContain("☐ 其他：______");
    expect(mainRows[6]![1]).toContain("☑ 运输过程损坏");
    expect(mainRows[7]![1]).toContain("☑ 是");
    expect(mainRows[8]![1]).toContain("☑ 否");
    expect(mainRows[9]![1]).toContain("☑ 是");
    expect(mainRows[10]![1]).toContain("☑ 否");
    expect(mainRows[13]![1]).toContain("☑ 是");
    expect(mainRows[14]![1]).toContain("☑ 立镖");
    expect(mainRows[18]![1]).toContain("运输过程中外壳破损");

    const materialRows = [...tables[1]!.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((match) => cellTexts(match[0]));
    expect(materialRows[0]).toEqual(["序号", "物料编码", "物料名称", "规格型号", "数量", "单位", "备注"]);
    expect(materialRows[1]).toEqual(["1", "M-001", "光电传感器", "E3Z-D61", "2", "个", "随主机补发"]);
    expect(materialRows[2]).toEqual(["2", "", "安装支架", "不锈钢", "1.5", "套", "含螺丝"]);
    expect(materialRows[3]).toEqual(["", "", "", "", "", "", ""]);

    expect(headerXml).toContain("浙江");
    expect(headerXml).toContain("立镖机器人有限公司");
    expect(headerXml).toContain("r:embed=\"rId1\"");
    expect(footerXml).toContain("地址：中国·");
    expect(footerXml).toContain("浙江省");
    expect(footerXml).toContain("临平区昌达路96号");
    expect(footerXml).toContain("www.libiaorobot.com");
    expect(footerXml).toContain("PAGE");
    expect(image.length).toBeGreaterThan(1000);
    expect(coreXml).toContain("<dc:creator>李四</dc:creator>");
  });
});

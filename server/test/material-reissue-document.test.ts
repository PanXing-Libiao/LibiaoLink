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
  address: "广州市黄埔区测试路 1 号",
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

describe("物料变更补发 DOCX", () => {
  it("生成可解压的 OOXML 包，文件名与表内申请时间按上海时区", async () => {
    expect(materialReissueFileName(SNAPSHOT, AT)).toBe("补发申请-LBGN23171-G1-202611091205.docx");

    const bytes = buildMaterialReissueDocx(SNAPSHOT, AT);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/app.xml",
      "docProps/core.xml",
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/styles.xml",
    ]);

    const documentEntry = zip.file("word/document.xml");
    const coreEntry = zip.file("docProps/core.xml");
    expect(documentEntry).not.toBeNull();
    expect(coreEntry).not.toBeNull();
    const documentXml = await documentEntry!.async("string");
    const coreXml = await coreEntry!.async("string");

    expect(documentXml).toContain("补发/补货申请表");
    expect(documentXml).toContain("LBGN23171-G1");
    expect(documentXml).toContain("虹迪广州NIKE分拣改造项目 &amp; 现场改造");
    expect(documentXml).not.toContain("虹迪广州NIKE分拣改造项目 & 现场改造");
    expect(documentXml).toContain("申请人");
    expect(documentXml).toContain("李四");
    expect(documentXml).toContain("2026-11-09 12:05");
    expect(documentXml).toContain("提交时间：2026-11-09 12:05");
    expect(documentXml).toContain("须先经夏总审批");
    expect(documentXml).toContain("运输过程损坏");
    expect(documentXml).toContain("光电传感器");
    expect(documentXml).toContain("E3Z-D61");
    expect(documentXml).toContain("安装支架");
    expect(documentXml).toContain("1.5");
    expect(coreXml).toContain("<dc:creator>李四</dc:creator>");
  });
});

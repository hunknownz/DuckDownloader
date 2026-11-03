import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import type { SourceAdapter } from "../src/ports.js";
import { DownloadService } from "../src/service.js";

function setup() {
  const adapter: SourceAdapter = {
    login: vi.fn(async () => {}),
    download: vi.fn(async () => "/tmp/doc.pdf"),
  };
  const service = new DownloadService(new Map([["scribd", adapter]]));
  const io = { out: vi.fn(), err: vi.fn() };
  return { adapter, service, io };
}

describe("CLI", () => {
  it("documents the supported local conversion and cleanup options in command help", async () => {
    const { service, io } = setup();
    expect(await runCli(["convert", "--help"], service, io)).toBe(0);
    const help = io.out.mock.calls.map(([message]) => message).join("");
    for (const option of [
      "<file>",
      "--output",
      "--title",
      "--keep-intermediates",
      "--cleanup-source",
    ])
      expect(help).toContain(option);
  });
  it("reports actual capabilities as JSON", async () => {
    const { service, io } = setup();
    expect(await runCli(["sources", "--json"], service, io)).toBe(0);
    const entries = JSON.parse(io.out.mock.calls[0]?.[0] ?? "[]");
    expect(entries.map((source: { id: string }) => source.id)).toEqual([
      "scribd",
      "slideshare",
      "everand",
      "fable",
      "wechat",
      "feishu",
    ]);
    expect(
      entries
        .filter((source: { canDownload: boolean }) => source.canDownload)
        .map((source: { id: string }) => source.id),
    ).toEqual(["scribd", "wechat", "feishu"]);
  });

  it("identifies the command by its new name in help output", async () => {
    const { service, io } = setup();
    expect(await runCli(["--help"], service, io)).toBe(0);
    expect(io.out.mock.calls.map(([message]) => message).join("")).toContain(
      "Usage: duckdownloader",
    );
  });

  it("inspects planned sources without starting a browser", async () => {
    const { adapter, service, io } = setup();
    expect(await runCli(["inspect", "https://everand.com/book/123"], service, io)).toBe(0);
    expect(JSON.parse(io.out.mock.calls[0]?.[0] ?? "{}").source.status).toBe("planned");
    expect(adapter.download).not.toHaveBeenCalled();
  });

  it("passes output, guest and normalized URL", async () => {
    const { adapter, service, io } = setup();
    expect(
      await runCli(
        ["download", "[A](https://scribd.com/document/123)", "--guest", "-o", "doc.pdf"],
        service,
        io,
      ),
    ).toBe(0);
    expect(adapter.download).toHaveBeenCalledWith(
      { url: "https://scribd.com/document/123", output: "doc.pdf", guest: true },
      expect.any(Function),
    );
  });

  it("defaults to the saved session", async () => {
    const { adapter, service, io } = setup();
    await runCli(["download", "https://scribd.com/document/123"], service, io);
    expect(adapter.download).toHaveBeenCalledWith(
      { url: "https://scribd.com/document/123", guest: false },
      expect.any(Function),
    );
  });

  it("forwards the Feishu login target and saved-session download through the CLI", async () => {
    const { adapter, io } = setup();
    const service = new DownloadService(new Map([["feishu", adapter]]));
    const url = "https://tenant.feishu.cn/docx/Abc123";
    expect(await runCli(["login", "--source", "feishu", "--url", url], service, io)).toBe(0);
    expect(adapter.login).toHaveBeenCalledWith(url);
    expect(await runCli(["download", url, "-o", "feishu.pdf"], service, io)).toBe(0);
    expect(adapter.download).toHaveBeenCalledWith(
      { url, output: "feishu.pdf", guest: false },
      expect.any(Function),
    );
  });

  it("downloads a WeChat article with its saved session and retains intermediates on request", async () => {
    const { adapter, io } = setup();
    const service = new DownloadService(new Map([["wechat", adapter]]));
    const url = "https://mp.weixin.qq.com/s/authorized-article";
    expect(
      await runCli(["download", url, "-o", "wechat.pdf", "--keep-intermediates"], service, io),
    ).toBe(0);
    expect(adapter.download).toHaveBeenCalledWith(
      { url, output: "wechat.pdf", guest: false, keepIntermediates: true },
      expect.any(Function),
    );
  });

  it("returns a failure for planned sources", async () => {
    const { adapter, service, io } = setup();
    expect(await runCli(["download", "https://fable.co/book/123"], service, io)).toBe(1);
    expect(io.err).toHaveBeenCalledWith(expect.stringContaining("尚未实现"));
    expect(adapter.download).not.toHaveBeenCalled();
  });

  it.each([{ args: ["--help"] }, { args: ["--version"] }, { args: ["download", "--help"] }])(
    "handles $args",
    async ({ args }) => {
      const { service, io } = setup();
      expect(await runCli(args, service, io)).toBe(0);
      expect(io.out).toHaveBeenCalled();
    },
  );

  it("returns argument errors with code 2", async () => {
    const { service, io } = setup();
    expect(await runCli(["login", "--source", "unknown"], service, io)).toBe(2);
    expect(io.err).toHaveBeenCalled();
  });

  it("forwards saved-page layout and cleanup options without using a source adapter", async () => {
    const { service, adapter, io } = setup();
    const converter = { convert: vi.fn(async () => "/tmp/retypeset.pdf") };
    expect(
      await runCli(
        [
          "convert",
          "saved.webarchive",
          "-o",
          "result.pdf",
          "--title",
          "Reading copy",
          "--cleanup-source",
          "--keep-intermediates",
        ],
        service,
        io,
        converter,
      ),
    ).toBe(0);
    expect(converter.convert).toHaveBeenCalledWith(
      {
        input: "saved.webarchive",
        output: "result.pdf",
        title: "Reading copy",
        cleanupSource: true,
        keepIntermediates: true,
      },
      expect.any(Function),
    );
    expect(adapter.download).not.toHaveBeenCalled();
  });

  it("allows source downloads to retain intermediate content explicitly", async () => {
    const { service, adapter, io } = setup();
    await runCli(
      ["download", "https://scribd.com/document/123", "--keep-intermediates"],
      service,
      io,
    );
    expect(adapter.download).toHaveBeenCalledWith(
      { url: "https://scribd.com/document/123", guest: false, keepIntermediates: true },
      expect.any(Function),
    );
  });
});

'use strict';

// Runs the unmodified production archive method against real Linux files and
// Commons Compress. Only Capacitor argument plumbing and the Android Os bridge
// are adapted for the host JVM; the injected fault removes a completed staging
// archive immediately before publication. This is not Android-device evidence.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const sourcePath = path.join(
  project,
  'android/app/src/main/java/io/sunho/SDStudio/ZipService.java',
);
const source = fs.readFileSync(sourcePath, 'utf8');
function between(begin, end) {
  const first = source.indexOf(begin);
  const last = source.indexOf(end, first);
  if (first < 0 || last < 0)
    throw new Error('Production archive method boundary not found');
  return source.slice(first, last);
}
const zipMethod = between(
  '  public void zipFiles(PluginCall call) {',
  '\n  // File.exists()',
)
  // atomicRename may now precede pathExists; exclude the subsequent plugin method.
  .split('\n  // POSIX rename replaces an existing destination atomically;')[0];
const addMethod = between(
  '  private void addFileToTar(',
  '\n  private InputStream openInputStreamFromUri(',
);
const javaRoot = process.env.SDSTUDIO_JAVA_HOME || process.env.JAVA_HOME;
if (!javaRoot)
  throw new Error(
    'Set JAVA_HOME or SDSTUDIO_JAVA_HOME to the installed JDK',
  );
const dependencyRoot = path.join(
  process.env.GRADLE_USER_HOME ||
    path.join(os.homedir(), '.gradle'),
  'caches/modules-2/files-2.1/org.apache.commons/commons-compress/1.21',
);
const jar =
  process.env.COMMONS_COMPRESS_JAR ||
  fs.readdirSync(dependencyRoot).flatMap((entry) =>
    fs
      .readdirSync(path.join(dependencyRoot, entry))
      .filter((name) => name === 'commons-compress-1.21.jar')
      .map((name) => path.join(dependencyRoot, entry, name)),
  )[0];
if (!jar)
  throw new Error('The already-used Commons Compress 1.21 JAR was not found');
const reportDirectory = path.resolve(
  process.env.SMOKE_REPORT_DIR ||
    path.join(project, '.report/android-archive-smoke'),
);
fs.mkdirSync(reportDirectory, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sdstudio-archive-java-'));
const result = {
  source: sourcePath,
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  dependencySha256: crypto
    .createHash('sha256')
    .update(fs.readFileSync(jar))
    .digest('hex'),
  overall: false,
};
const javaSource = `
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;

public class ArchivePublicationHarness {
  static Path staging;
  static boolean removeStagingAfterClose;

  static class JSONObject {
    final Map<String, String> values = new HashMap<>();
    JSONObject(String name, String input) { values.put("name", name); values.put("path", input); }
    String getString(String name) { return values.get(name); }
  }
  static class FileArray {
    final List<JSONObject> entries;
    FileArray(List<JSONObject> value) { entries = value; }
    List<JSONObject> toList() { return entries; }
  }
  static class PluginCall {
    final String outPath;
    final FileArray files;
    boolean resolved;
    Exception failure;
    PluginCall(Path out, Path input) {
      outPath = out.toString();
      files = new FileArray(List.of(new JSONObject("payload.txt", input.toString())));
    }
    String getString(String name) { return outPath; }
    FileArray getArray(String name) { return files; }
    void resolve() { resolved = true; }
    void reject(String message, Exception error) { failure = error; }
  }
  static class TarArchiveOutputStream extends org.apache.commons.compress.archivers.tar.TarArchiveOutputStream {
    TarArchiveOutputStream(OutputStream out) { super(out); }
    @Override public void close() throws IOException {
      super.close();
      if (removeStagingAfterClose) Files.delete(staging);
    }
  }
  static class android {
    static class system {
      static class Os {
        static void rename(String from, String to) throws IOException {
          Files.move(Path.of(from), Path.of(to), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        }
      }
    }
  }
  ${zipMethod}
  ${addMethod}

  static void require(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
  public static void main(String[] args) throws Exception {
    Path root = Path.of(args[0]);
    Path input = root.resolve("input.txt");
    String payload = "saved input retains its original bytes";
    Files.writeString(input, payload);
    ArchivePublicationHarness subject = new ArchivePublicationHarness();

    Path normal = root.resolve("normal.tar");
    Files.writeString(normal, "old archive");
    staging = Path.of(normal + ".part");
    PluginCall normalCall = new PluginCall(normal, input);
    subject.zipFiles(normalCall);
    require(normalCall.resolved && normalCall.failure == null, "Normal TAR write failed");
    try (TarArchiveInputStream in = new TarArchiveInputStream(Files.newInputStream(normal))) {
      TarArchiveEntry entry = in.getNextTarEntry();
      require(entry != null && entry.getName().equals("payload.txt"), "TAR entry mismatch");
      require(new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).equals(payload), "TAR content mismatch");
      require(in.getNextTarEntry() == null, "Unexpected extra TAR entry");
    }
    require(!Files.exists(staging), "Successful TAR left a staging file");
    System.out.println("PASS normal TAR replacement and content");

    Path zip = root.resolve("normal.zip");
    Files.writeString(zip, "old zip");
    PluginCall zipCall = new PluginCall(zip, input);
    subject.zipFiles(zipCall);
    require(zipCall.resolved && zipCall.failure == null, "Normal ZIP write failed");
    try (ZipFile in = new ZipFile(zip.toFile())) {
      ZipEntry entry = in.getEntry("payload.txt");
      require(entry != null, "ZIP entry missing");
      require(new String(in.getInputStream(entry).readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).equals(payload), "ZIP content mismatch");
    }
    System.out.println("PASS normal ZIP replacement and content");

    Path failed = root.resolve("retained.tar");
    String previous = "previous completed archive must survive";
    Files.writeString(failed, previous);
    staging = Path.of(failed + ".part");
    removeStagingAfterClose = true;
    PluginCall failedCall = new PluginCall(failed, input);
    subject.zipFiles(failedCall);
    require(!failedCall.resolved && failedCall.failure != null, "A missing staged archive must reject publication");
    require(Files.exists(failed), "Failed TAR replacement deleted the previous archive");
    require(Files.readString(failed).equals(previous), "Failed TAR replacement changed previous archive bytes");
    require(Files.readString(input).equals(payload), "Source input changed during failed publication");
    System.out.println("PASS failed TAR replacement preserves previous archive and input");
  }
}
`;
try {
  const file = path.join(work, 'ArchivePublicationHarness.java');
  fs.writeFileSync(file, javaSource);
  const compile = spawnSync(
    path.join(javaRoot, 'bin/javac'),
    ['-encoding', 'UTF-8', '-cp', jar, file],
    { encoding: 'utf8', timeout: 60000 },
  );
  result.compile = {
    exitCode: compile.status,
    stdout: compile.stdout,
    stderr: compile.stderr,
    error: compile.error?.message,
  };
  if (compile.status !== 0)
    throw new Error('Java archive harness compilation failed');
  const run = spawnSync(
    path.join(javaRoot, 'bin/java'),
    [
      '-cp',
      `${work}${path.delimiter}${jar}`,
      'ArchivePublicationHarness',
      work,
    ],
    { encoding: 'utf8', timeout: 60000 },
  );
  result.run = {
    exitCode: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    error: run.error?.message,
  };
  result.overall = run.status === 0;
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  if (!result.overall) process.exitCode = 1;
} catch (error) {
  result.error = error.message;
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(
    path.join(reportDirectory, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  fs.rmSync(work, { recursive: true, force: true });
}

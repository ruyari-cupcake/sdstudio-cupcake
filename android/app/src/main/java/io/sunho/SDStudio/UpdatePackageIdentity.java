package io.sunho.SDStudio;

import java.util.Set;

/** Package metadata accepted before handing the APK to Android's installer. */
public final class UpdatePackageIdentity {
  private UpdatePackageIdentity() {}

  public static boolean accepts(
      String installedId,
      long installedCode,
      Set<String> installedSigners,
      String expectedVersion,
      long expectedCode,
      String candidateId,
      String candidateVersion,
      long candidateCode,
      Set<String> candidateSigners) {
    return installedId.equals(candidateId)
        && expectedVersion.equals(candidateVersion)
        && candidateCode == expectedCode
        && candidateCode > installedCode
        && installedSigners != null
        && !installedSigners.isEmpty()
        && installedSigners.equals(candidateSigners);
  }
}

package io.sunho.SDStudio;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

public class UpdatePackageIdentityTest {
  private static final String ID = "io.example.private";
  private static final String VERSION = "6.1.0-cupcake.1";
  private static final Set<String> SIGNERS = Collections.singleton("owner-certificate");
  private boolean accepts(String id, String version, long code, Set<String> signers) {
    return UpdatePackageIdentity.accepts(ID, 6000006, SIGNERS, VERSION, 6010001,
        id, version, code, signers);
  }

  @Test public void acceptsTheNewReleaseWithTheInstalledIdentityAndSigner() {
    assertTrue(accepts(ID, VERSION, 6010001, SIGNERS));
  }
  @Test public void rejectsPublicApkOnPrivateInstallation() {
    assertFalse(accepts("io.example.public", VERSION, 6010001, SIGNERS));
  }
  @Test public void rejectsDifferentOrMissingSigners() {
    assertFalse(accepts(ID, VERSION, 6010001, Collections.singleton("other-certificate")));
    assertFalse(accepts(ID, VERSION, 6010001, Collections.emptySet()));
    Set<String> extra = new HashSet<>(SIGNERS);
    extra.add("unexpected-certificate");
    assertFalse(accepts(ID, VERSION, 6010001, extra));
    assertFalse(UpdatePackageIdentity.accepts(ID, 6000006, Collections.emptySet(),
        VERSION, 6010001, ID, VERSION, 6010001, Collections.emptySet()));
  }
  @Test public void rejectsDowngradesAndVersionsDifferentFromTheReleaseManifest() {
    assertFalse(accepts(ID, VERSION, 6000006, SIGNERS));
    assertFalse(accepts(ID, "6.2.0-cupcake.1", 6010001, SIGNERS));
    assertFalse(accepts(ID, VERSION, 6010002, SIGNERS));
    assertFalse(UpdatePackageIdentity.accepts(ID, 6010001, SIGNERS,
        VERSION, 6010001, ID, VERSION, 6010001, SIGNERS));
  }
}

package main_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The binary itself, run as a process.
//
// Everything else tests `hub.Handler` through `httptest`, which never touches
// main() -- and a refactor duly dropped the `ListenAndServe` call from the
// plaintext path entirely. The server logged "listening on http://..." and then
// listened to nothing. It shipped, and only a browser probe that checked its
// own fixtures caught it. This is the cheapest possible guard against the whole
// class: does the program, started the way a self-hoster starts it, answer.

func build(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "videosyncd")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return bin
}

// freePort asks the kernel for one, so parallel test runs cannot collide.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitHealthy(t *testing.T, client *http.Client, url string, proc *exec.Cmd) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if proc.ProcessState != nil && proc.ProcessState.Exited() {
			t.Fatalf("the server exited before it answered: %v", proc.ProcessState)
		}
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("no answer from %s -- the process is running but nothing is listening", url)
}

func TestBinaryServesPlaintext(t *testing.T) {
	bin := build(t)
	port := freePort(t)
	cmd := exec.Command(bin, "-addr", fmt.Sprintf("127.0.0.1:%d", port))
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	waitHealthy(t, http.DefaultClient, fmt.Sprintf("http://127.0.0.1:%d/healthz", port), cmd)
}

func TestBinaryServesTLS(t *testing.T) {
	// TLS is not optional in deployment -- an https page can reach neither http
	// nor ws (docs/BROWSER-FINDINGS.md section 8) -- so the flags that enable it
	// are as load-bearing as the plaintext path.
	dir := t.TempDir()
	certPath, keyPath, pool := writeSelfSigned(t, dir)
	bin := build(t)
	port := freePort(t)
	cmd := exec.Command(bin, "-addr", fmt.Sprintf("127.0.0.1:%d", port),
		"-tls-cert", certPath, "-tls-key", keyPath)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })

	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool},
	}}
	waitHealthy(t, client, fmt.Sprintf("https://127.0.0.1:%d/healthz", port), cmd)
}

func TestBinaryRefusesHalfConfiguredTLS(t *testing.T) {
	// A cert with no key silently falling back to plaintext would be the worst
	// of both: the operator believes they are on TLS and no browser can reach
	// them.
	bin := build(t)
	out, err := exec.Command(bin, "-addr", "127.0.0.1:0", "-tls-cert", "x.pem").CombinedOutput()
	if err == nil {
		t.Fatal("started with a certificate and no key")
	}
	if !contains(string(out), "must be given together") {
		t.Fatalf("unhelpful refusal: %s", out)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func writeSelfSigned(t *testing.T, dir string) (certPath, keyPath string, pool *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPath = filepath.Join(dir, "cert.pem")
	keyPath = filepath.Join(dir, "key.pem")
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		t.Fatal(err)
	}
	pool = x509.NewCertPool()
	pool.AppendCertsFromPEM(certPEM)
	return certPath, keyPath, pool
}

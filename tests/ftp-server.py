import os
import sys

from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer

root, port = sys.argv[1], int(sys.argv[2])
authorizer = DummyAuthorizer()
authorizer.add_user("tester", os.environ["ED_TEST_FTP_PASSWORD"], root, perm="elradfmwMT")
class TestHandler(FTPHandler):
    def ftp_PASS(self, line):
        if line == "DO_NOT_PRINT_THIS_PASSWORD":
            self.respond(f"530 Password rejected: {line}")
        else:
            super().ftp_PASS(line)

    def ftp_EPSV(self, line):
        if os.environ.get("ED_TEST_NO_EPSV") == "1":
            self.respond("502 EPSV disabled for test")
        else:
            super().ftp_EPSV(line)

    def ftp_MLSD(self, path):
        if os.environ.get("ED_TEST_NO_MLSD") == "1":
            self.respond("500 MLSD disabled for test")
        else:
            super().ftp_MLSD(path)

    def ftp_RETR(self, file):
        if os.path.basename(file) == "drop.txt":
            self.close()
        else:
            super().ftp_RETR(file)


handler = TestHandler
handler.authorizer = authorizer
FTPServer(("127.0.0.1", port), handler).serve_forever()

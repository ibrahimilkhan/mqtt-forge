import { useMutation, useQuery } from '@tanstack/react-query';
import {
  getCertificateDialog,
  pickCertificateFile,
  type CertificateFileKind,
} from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { logFault } from '../../stores/logStore';

/**
 * The host's file dialog, for the three boxes an encrypted connection can be given.
 *
 * The boxes hold paths rather than files, and they have to: the connection is held by the server,
 * so a certificate is opened where that server runs. A file input would hand over the bytes with
 * the path hidden — every browser does that on purpose — and the bytes are no use to a process
 * that has to read the file itself. So the dialog belongs to the host, and where there is no host
 * window there is no dialog and the boxes stay boxes you type into.
 *
 * Nothing is cached but the capability. A path is on its way to the form, and the form is where
 * it lives.
 */
export function useCertificateFile() {
  const { data } = useQuery({
    queryKey: queryKeys.certificateDialog,
    queryFn: getCertificateDialog,
    // The answer is a fact about the host, fixed for the life of the process. Asking again on
    // every remount of the panel is three requests to be told the same thing.
    staleTime: Infinity,
  });

  const pick = useMutation({
    mutationFn: pickCertificateFile,
    onError: (error) => logFault('Could not open the file dialog', error),
  });

  return {
    canChoose: data?.canChoose ?? false,
    // One dialog at a time — the host refuses a second — so every button waits on the one open.
    choosing: pick.isPending,

    /**
     * Opens the dialog and answers with the path, or null for a dialog that was dismissed.
     *
     * Never rejects. Its callers are click handlers, where a bare mutateAsync is an unhandled
     * rejection the moment the host refuses — which it does when the other console this app
     * exists to be opened on already has a dialog up. What went wrong is on the log.
     */
    choose: (kind: CertificateFileKind): Promise<string | null> =>
      pick
        .mutateAsync(kind)
        .then((answer) => answer.path)
        .catch(() => null),
  };
}

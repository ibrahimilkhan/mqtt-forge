// SingleInstanceTests.Dispose_leaves_no_stray_pipe_file_after_a_signal_was_serviced (unmodified,
// not ours to touch) proves its point by diffing the OS temp directory's "CoreFxPipe_mqf-*"
// files before and after. That glob is not scoped to one test's own pipe - by construction it
// matches every SingleInstance-derived pipe in the process. xUnit runs different test classes
// (= different collections, by default) concurrently, so once SingleInstanceCrossProcessTests
// started holding real subprocess-backed pipes for a measurable window, that snapshot could
// catch an unrelated pipe mid-flight and fail an assert that has nothing to do with a real leak.
// Serializing the whole assembly removes the false positive without editing the test itself.
[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]

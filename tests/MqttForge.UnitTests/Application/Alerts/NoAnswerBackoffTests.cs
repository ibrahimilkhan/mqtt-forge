using MqttForge.Application.Alerts;

namespace MqttForge.UnitTests.Application.Alerts;

// How long a pump leaves its filters after a broker that did not answer for them: longer each time
// in a row, a minute at most, and short again once the broker answers or the link is new.
public class NoAnswerBackoffTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 27, 9, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData(1, 5)]
    [InlineData(2, 10)]
    [InlineData(3, 20)]
    [InlineData(4, 40)]
    [InlineData(5, 60)]
    [InlineData(6, 60)]
    [InlineData(1_000, 60)]
    public void Each_attempt_in_a_row_left_unanswered_doubles_the_pause_up_to_a_minute(int unanswered, int seconds) =>
        Assert.Equal(TimeSpan.FromSeconds(seconds), NoAnswerBackoff.After(unanswered));

    // The second in a row puts the next attempt off by ten seconds, and to the second.
    [Fact]
    public void The_pause_puts_off_the_next_attempt_until_it_is_over()
    {
        var backoff = new NoAnswerBackoff();
        Assert.False(backoff.Pausing(T0));

        backoff.NotAnswered(T0);
        var asked = T0.AddSeconds(5);
        var over = asked + backoff.NotAnswered(asked);

        Assert.Equal(asked.AddSeconds(10), over);
        Assert.True(backoff.Pausing(asked));
        Assert.True(backoff.Pausing(over.AddSeconds(-1)));
        Assert.False(backoff.Pausing(over));
    }

    // Yes or no, the broker answered: the next silence is the first of a new run.
    [Fact]
    public void An_answer_starts_the_next_run_of_pauses_from_the_first()
    {
        var backoff = new NoAnswerBackoff();
        backoff.NotAnswered(T0);
        backoff.NotAnswered(T0.AddSeconds(5));

        backoff.Answered();

        Assert.Equal(NoAnswerBackoff.First, backoff.NotAnswered(T0.AddSeconds(20)));
    }

    // A new link is a new answer: nothing is put off, and the next silence is the first again.
    [Fact]
    public void A_new_link_lifts_the_pause_and_starts_the_next_run_from_the_first()
    {
        var backoff = new NoAnswerBackoff();
        backoff.NotAnswered(T0);
        backoff.NotAnswered(T0.AddSeconds(5));

        backoff.Lift();

        Assert.False(backoff.Pausing(T0.AddSeconds(6)));
        Assert.Equal(NoAnswerBackoff.First, backoff.NotAnswered(T0.AddSeconds(6)));
    }

    // The reader's own save or deploy asks at once, whatever the pause. It is no answer, though: an
    // attempt the broker leaves unanswered after it is the next of the run, not the first of a new one.
    [Fact]
    public void A_save_ends_the_pause_and_the_run_goes_on()
    {
        var backoff = new NoAnswerBackoff();
        backoff.NotAnswered(T0);
        var asked = T0.AddSeconds(5);
        backoff.NotAnswered(asked);

        backoff.Interrupt();

        var saved = asked.AddSeconds(1);
        Assert.False(backoff.Pausing(saved));
        Assert.Equal(NoAnswerBackoff.After(3), backoff.NotAnswered(saved));
    }

    // A pause that ends further off than the whole of it is a clock set back since, and is over. The
    // whole of it is the pause standing, not the first one.
    [Fact]
    public void A_clock_set_back_ends_the_pause_and_a_long_one_is_not_taken_for_it()
    {
        var backoff = new NoAnswerBackoff();
        backoff.NotAnswered(T0);
        var asked = T0.AddSeconds(5);
        backoff.NotAnswered(asked);

        Assert.True(backoff.Pausing(asked));
        Assert.False(backoff.Pausing(asked.AddSeconds(-30)));
    }
}
